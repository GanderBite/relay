import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import matter from 'gray-matter';

import { type AgentsResolutionDetails, AgentsResolutionError } from '../../errors.js';
import { agentDefinitionSchema } from '../../flow/schemas.js';
import { type AgentDefinition, type AgentsFromSpec, isAgentsFromSpec } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import { atomicWriteJson } from '../../util/atomic-write.js';

export interface AgentsResolutionContext {
  runDir: string;
  stepId: string;
  flowDir: string;
  handoffStore: HandoffStore;
  inputVars: Record<string, unknown>;
}

type Reason = AgentsResolutionDetails['reason'];

// dotPath: copied from script-env so executor modules stay decoupled.
function dotPath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const errnoOf = (c: unknown): string | undefined =>
  c instanceof Error && 'code' in c && typeof c.code === 'string' ? c.code : undefined;
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asStrArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

function fail(message: string, reason: Reason, extra: Record<string, unknown> = {}): never {
  throw new AgentsResolutionError(message, { reason, ...extra });
}

// Refuses absolute paths and any traversal that escapes flowDir, mirroring
// resolvePromptPath in exec/prompt.ts.
function resolveBasePath(flowDir: string, base: string, agentName: string): string {
  if (isAbsolute(base)) {
    fail(`agent "${agentName}": extends must be relative, got "${base}"`, 'extends-not-found', {
      agentName,
      ref: base,
    });
  }
  const root = resolve(flowDir);
  const full = resolve(flowDir, '.claude', 'agents', `${base}.md`);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) {
    fail(`agent "${agentName}": extends "${base}" escapes flow directory`, 'extends-not-found', {
      agentName,
      ref: base,
    });
  }
  return full;
}

// Base fields lifted from a `.claude/agents/<base>.md` frontmatter + body.
type AgentBase = Pick<
  AgentDefinition,
  'description' | 'model' | 'tools' | 'skills' | 'systemPrompt'
>;

async function readBase(flowDir: string, def: AgentDefinition): Promise<AgentBase> {
  const base = def.extends as string;
  const full = resolveBasePath(flowDir, base, def.name);
  let raw: string;
  try {
    raw = await readFile(full, 'utf8');
  } catch (cause) {
    const verb = errnoOf(cause) === 'ENOENT' ? 'not found' : 'failed to read';
    fail(`agent "${def.name}": ${verb} extends target "${base}" at ${full}`, 'extends-not-found', {
      agentName: def.name,
      ref: base,
      cause,
    });
  }
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (cause) {
    fail(
      `agent "${def.name}": failed to parse frontmatter in "${base}.md"`,
      'frontmatter-parse-error',
      { agentName: def.name, ref: base, cause },
    );
  }
  const data = parsed.data;
  const body = parsed.content.trim();
  return {
    description: asStr(data['description']),
    model: asStr(data['model']),
    tools: asStrArr(data['tools']),
    skills: asStrArr(data['skills']),
    systemPrompt: asStr(data['prompt']) ?? (body.length > 0 ? body : undefined),
  };
}

function mergeSkills(
  b: string[] | undefined,
  o: string[] | undefined,
  mode: 'replace' | 'append' | undefined,
): string[] | undefined {
  if (mode !== 'append') return o ?? b;
  const combined = [...(b ?? []), ...(o ?? [])];
  return combined.length === 0 ? undefined : Array.from(new Set(combined));
}

async function applyExtends(def: AgentDefinition, flowDir: string): Promise<AgentDefinition> {
  if (def.extends === undefined) return def;
  const base = await readBase(flowDir, def);
  const merged: AgentDefinition = { name: def.name };
  const description = def.description ?? base.description;
  const model = def.model ?? base.model;
  const tools = def.tools ?? base.tools;
  const systemPrompt = def.systemPrompt ?? base.systemPrompt;
  const skills = mergeSkills(base.skills, def.skills, def.skillsMerge);
  if (description !== undefined) merged.description = description;
  if (model !== undefined) merged.model = model;
  if (tools !== undefined) merged.tools = tools;
  if (skills !== undefined) merged.skills = skills;
  if (systemPrompt !== undefined) merged.systemPrompt = systemPrompt;
  return merged;
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
    'handoff-missing',
    { ref: from },
  );
}

async function resolveFromSpec(
  spec: AgentsFromSpec,
  ctx: AgentsResolutionContext,
): Promise<AgentDefinition[]> {
  const { from } = spec;
  const isRequired = spec.required === true;
  const resolved = await resolveRef(from, ctx, isRequired);
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
 * `InvocationRequest.agents`. Applies `extends`, merges skills, deduplicates
 * by name, and writes a debug artifact at `<runDir>/<stepId>/agents.json`.
 * Throws `AgentsResolutionError` on every failure before returning.
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
