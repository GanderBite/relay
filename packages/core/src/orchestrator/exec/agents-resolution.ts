import { join } from 'node:path';

import { type AgentsResolutionDetails, AgentsResolutionError } from '../../errors.js';
import { agentDefinitionSchema } from '../../flow/schemas.js';
import { type AgentDefinition, type AgentsFromSpec, isAgentsFromSpec } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import { atomicWriteJson } from '../../util/atomic-write.js';
import { dotPath } from '../../util/dot-path.js';
import { applyExtends } from './agents-extends.js';

export interface AgentsResolutionContext {
  runDir: string;
  stepId: string;
  flowDir: string;
  handoffStore: HandoffStore;
  inputVars: Record<string, unknown>;
}

type Reason = AgentsResolutionDetails['reason'];

function fail(message: string, reason: Reason, extra: Record<string, unknown> = {}): never {
  throw new AgentsResolutionError(message, { reason, ...extra });
}

// Resolves "handoff.<id>.<rest>" or "input.<path>"; returns raw unknown.
async function resolveRef(
  from: string,
  ctx: AgentsResolutionContext,
  isRequired: boolean,
): Promise<unknown> {
  if (from.startsWith('input.')) return dotPath(ctx.inputVars, from.slice(6));
  if (from.startsWith('handoff.')) {
    const suffix = from.slice(8);
    const dot = suffix.indexOf('.');
    const id = dot === -1 ? suffix : suffix.slice(0, dot);
    const rest = dot === -1 ? '' : suffix.slice(dot + 1);
    const read = await ctx.handoffStore.read(id);
    if (read.isErr()) {
      if (isRequired) {
        fail(
          `agents.from "${from}" required but handoff "${id}" could not be read: ${read.error.message}`,
          'handoff-missing',
          { ref: from, cause: read.error },
        );
      }
      return undefined;
    }
    if (rest === '') return read.value;
    return typeof read.value === 'object' && read.value !== null
      ? dotPath(read.value as Record<string, unknown>, rest)
      : undefined;
  }
  fail(
    `agents.from "${from}": unrecognized prefix — expected "input.<path>" or "handoff.<path>"`,
    'handoff-shape-invalid',
    { ref: from },
  );
}

async function resolveFromSpec(
  spec: AgentsFromSpec,
  ctx: AgentsResolutionContext,
): Promise<AgentDefinition[]> {
  const { from } = spec;
  const isRequired = spec.required === true;
  let resolved = await resolveRef(from, ctx, isRequired);
  if (spec.path !== undefined && resolved !== undefined && resolved !== null) {
    resolved =
      typeof resolved === 'object'
        ? dotPath(resolved as Record<string, unknown>, spec.path)
        : undefined;
  }
  if (resolved === undefined || resolved === null) {
    if (isRequired) {
      fail(
        `agents.from "${from}" is required but resolved to ${resolved === null ? 'null' : 'undefined'}`,
        'handoff-missing',
        { ref: from },
      );
    }
    return [];
  }
  if (!Array.isArray(resolved)) {
    fail(`agents.from "${from}" resolved to a non-array value`, 'handoff-shape-invalid', {
      ref: from,
    });
  }
  const out: AgentDefinition[] = [];
  for (const [i, entry] of resolved.entries()) {
    const parsed = agentDefinitionSchema.safeParse(entry);
    if (!parsed.success) {
      fail(
        `agents.from "${from}"[${i}] failed schema validation: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
        'handoff-shape-invalid',
        { ref: from, cause: parsed.error.issues },
      );
    }
    out.push(parsed.data);
  }
  return out;
}

// Strips relay-only fields (`extends`, `skillsMerge`). The provider arg
// builder handles the in-memory -> wire rename at the boundary.
function toWireRecord(def: AgentDefinition): Record<string, unknown> {
  const r: Record<string, unknown> = { name: def.name };
  if (def.description !== undefined) r['description'] = def.description;
  if (def.model !== undefined) r['model'] = def.model;
  if (def.tools !== undefined) r['tools'] = def.tools;
  if (def.skills !== undefined) r['skills'] = def.skills;
  if (def.systemPrompt !== undefined) r['systemPrompt'] = def.systemPrompt;
  return r;
}

/**
 * Resolves a prompt step's `agents` field into a flat array suitable for
 * `InvocationRequest.agents`. Applies `extends`, merges skills, rejects
 * duplicate names, and writes a debug artifact at
 * `<runDir>/<stepId>/agents.json`. Throws `AgentsResolutionError` on every
 * failure before returning.
 */
export async function resolveAgents(
  agents: AgentDefinition[] | AgentsFromSpec,
  ctx: AgentsResolutionContext,
): Promise<Array<Record<string, unknown>>> {
  const list: AgentDefinition[] = isAgentsFromSpec(agents)
    ? await resolveFromSpec(agents, ctx)
    : agents;
  if (list.length === 0) return [];

  const seen = new Set<string>();
  for (const def of list) {
    if (seen.has(def.name)) {
      fail(`duplicate agent name "${def.name}"`, 'duplicate-name', {
        agentName: def.name,
        stepId: ctx.stepId,
      });
    }
    seen.add(def.name);
  }

  const resolvedList: AgentDefinition[] = [];
  for (const def of list) resolvedList.push(await applyExtends(def, ctx.flowDir));
  const wire = resolvedList.map(toWireRecord);

  const artifactPath = join(ctx.runDir, ctx.stepId, 'agents.json');
  const write = await atomicWriteJson(artifactPath, wire);
  if (write.isErr()) {
    fail(`failed to write agents debug artifact at ${artifactPath}`, 'handoff-shape-invalid', {
      stepId: ctx.stepId,
      ref: artifactPath,
      cause: write.error,
    });
  }
  return wire;
}
