import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import matter from 'gray-matter';

import { type AgentsResolutionDetails, AgentsResolutionError } from '../../errors.js';
import type { AgentDefinition } from '../../flow/types.js';

type Reason = AgentsResolutionDetails['reason'];

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

/**
 * Resolves an agent's `extends` reference by loading the base `.md` file from
 * `<flowDir>/.claude/agents/<extends>.md`, parsing its frontmatter + body, and
 * merging the base fields with the inline overrides. Returns the original
 * definition unchanged when `extends` is absent.
 *
 * Override fields always win. `skills` is governed by `skillsMerge`:
 *   - `'append'`  — base skills + override skills, deduped.
 *   - undefined / `'replace'` — override skills replace base skills entirely.
 *
 * Throws `AgentsResolutionError` with one of:
 *   - `extends-not-found`       — base path is absolute, escapes flowDir, or missing.
 *   - `frontmatter-parse-error` — base file has invalid YAML frontmatter.
 */
export async function applyExtends(
  def: AgentDefinition,
  flowDir: string,
): Promise<AgentDefinition> {
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
