/**
 * Unit tests for resolveAgents (packages/core/src/orchestrator/exec/agents-resolution.ts).
 *
 * Coverage:
 *  - Inline array: in-memory shape has name + systemPrompt, strips extends/skillsMerge
 *  - Inline array: passes tools, model, description, skills through unchanged
 *  - Inline array: writes agents.json to <runDir>/<stepId>/agents.json
 *  - AgentsFromSpec: resolves from a valid handoff array
 *  - AgentsFromSpec: required false + missing handoff → returns []
 *  - AgentsFromSpec: required true + missing handoff → AgentsResolutionError(reason: 'handoff-missing')
 *  - AgentsFromSpec: handoff is not an array → AgentsResolutionError(reason: 'handoff-shape-invalid')
 *  - extends: merges base with override (override systemPrompt wins)
 *  - extends: skillsMerge 'append' accumulates skills from base + override
 *  - extends: skillsMerge 'replace' (default) replaces base skills with override skills
 *  - extends: missing base → AgentsResolutionError(reason: 'extends-not-found')
 *  - extends: malformed YAML frontmatter → AgentsResolutionError(reason: 'frontmatter-parse-error')
 *  - duplicate-name: two entries with the same name → AgentsResolutionError(reason: 'duplicate-name')
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentsResolutionError } from '../../../src/errors.js';
import type { AgentDefinition, AgentsFromSpec } from '../../../src/flow/types.js';
import { HandoffStore } from '../../../src/handoffs.js';
import type { AgentsResolutionContext } from '../../../src/orchestrator/exec/agents-resolution.js';
import { resolveAgents } from '../../../src/orchestrator/exec/agents-resolution.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let runDir: string;
let flowDir: string;
let handoffStore: HandoffStore;

const STEP_ID = 'step-agents';

function mkCtx(overrides?: Partial<AgentsResolutionContext>): AgentsResolutionContext {
  return {
    runDir,
    stepId: STEP_ID,
    flowDir,
    handoffStore,
    inputVars: {},
    ...overrides,
  };
}

beforeEach(async () => {
  const base = join(tmpdir(), `relay-agents-test-${randomUUID()}`);
  runDir = base;
  flowDir = join(base, 'flow');
  await mkdir(join(runDir, STEP_ID), { recursive: true });
  await mkdir(flowDir, { recursive: true });
  handoffStore = new HandoffStore(runDir);
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Group 1: Inline agents array — no extends
// ---------------------------------------------------------------------------

describe('resolveAgents — inline array', () => {
  it('[AR-001] returned entries have name and systemPrompt (in-memory shape)', async () => {
    const agents: AgentDefinition[] = [{ name: 'reviewer', systemPrompt: 'Review the code.' }];
    const result = await resolveAgents(agents, mkCtx());
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('name', 'reviewer');
    expect(result[0]).toHaveProperty('systemPrompt', 'Review the code.');
  });

  it('[AR-002] returned entries lack extends and skillsMerge', async () => {
    // No extends field — applyExtends is a no-op. skillsMerge is relay-only
    // metadata stripped by toWireRecord before the result is returned.
    const agents: AgentDefinition[] = [
      { name: 'coder', systemPrompt: 'Write code.', skillsMerge: 'append', skills: ['vitest'] },
    ];
    const result = await resolveAgents(agents, mkCtx());
    expect(result[0]).not.toHaveProperty('extends');
    expect(result[0]).not.toHaveProperty('skillsMerge');
  });

  it('[AR-003] passes tools, model, description, and skills through unchanged', async () => {
    const agents: AgentDefinition[] = [
      {
        name: 'auditor',
        description: 'Security auditor',
        model: 'claude-opus-4',
        tools: ['bash', 'read'],
        skills: ['typescript'],
        systemPrompt: 'Audit the code.',
      },
    ];
    const result = await resolveAgents(agents, mkCtx());
    expect(result[0]).toMatchObject({
      name: 'auditor',
      description: 'Security auditor',
      model: 'claude-opus-4',
      tools: ['bash', 'read'],
      skills: ['typescript'],
      systemPrompt: 'Audit the code.',
    });
  });

  it('[AR-004] writes agents.json to <runDir>/<stepId>/agents.json', async () => {
    const agents: AgentDefinition[] = [{ name: 'writer', systemPrompt: 'Write prose.' }];
    await resolveAgents(agents, mkCtx());

    const artifactPath = join(runDir, STEP_ID, 'agents.json');
    const raw = await readFile(artifactPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Array<Record<string, unknown>>;
    expect(arr[0]).toHaveProperty('name', 'writer');
    expect(arr[0]).toHaveProperty('systemPrompt', 'Write prose.');
  });

  it('[AR-005] empty inline array returns [] without writing agents.json', async () => {
    const result = await resolveAgents([], mkCtx());
    expect(result).toEqual([]);
    // No file written for empty list
    await expect(readFile(join(runDir, STEP_ID, 'agents.json'), 'utf8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 2: AgentsFromSpec — handoff.path resolution
// ---------------------------------------------------------------------------

describe('resolveAgents — AgentsFromSpec', () => {
  it('[AR-010] resolves when handoff contains a valid agents array', async () => {
    const agentsData = [{ name: 'reviewer', systemPrompt: 'Review carefully.' }];
    await handoffStore.write('agents-list', agentsData);

    const spec: AgentsFromSpec = { from: 'handoff.agents-list' };
    const result = await resolveAgents(spec, mkCtx());
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('name', 'reviewer');
  });

  it('[AR-011] returns [] when required: false and handoff is missing', async () => {
    const spec: AgentsFromSpec = { from: 'handoff.no-such-handoff', required: false };
    const result = await resolveAgents(spec, mkCtx());
    expect(result).toEqual([]);
  });

  it('[AR-012] throws AgentsResolutionError(reason: handoff-missing) when required: true and handoff absent', async () => {
    const spec: AgentsFromSpec = { from: 'handoff.no-such-handoff', required: true };
    await expect(resolveAgents(spec, mkCtx())).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentsResolutionError && e.details?.reason === 'handoff-missing',
    );
  });

  it('[AR-013] throws AgentsResolutionError(reason: handoff-shape-invalid) when handoff is not an array', async () => {
    await handoffStore.write('scalar-handoff', { agents: 'not-an-array' });
    const spec: AgentsFromSpec = { from: 'handoff.scalar-handoff' };
    await expect(resolveAgents(spec, mkCtx())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AgentsResolutionError && e.details?.reason === 'handoff-shape-invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// Group 3: extends resolution
// ---------------------------------------------------------------------------

async function writeBaseAgent(name: string, content: string): Promise<void> {
  const agentsDir = join(flowDir, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, `${name}.md`), content, 'utf8');
}

describe('resolveAgents — extends resolution', () => {
  it('[AR-020] merges base frontmatter with override; override systemPrompt wins', async () => {
    await writeBaseAgent(
      'base-reviewer',
      `---
description: Base description
model: claude-haiku-4
systemPrompt: Base system prompt
---
Base body prompt
`,
    );

    const agents: AgentDefinition[] = [
      {
        name: 'my-reviewer',
        extends: 'base-reviewer',
        systemPrompt: 'Override prompt wins.',
      },
    ];
    const result = await resolveAgents(agents, mkCtx());
    expect(result[0]).toHaveProperty('systemPrompt', 'Override prompt wins.');
    expect(result[0]).toHaveProperty('description', 'Base description');
    expect(result[0]).toHaveProperty('model', 'claude-haiku-4');
    expect(result[0]).not.toHaveProperty('extends');
  });

  it('[AR-021] base systemPrompt from body is used when override lacks systemPrompt', async () => {
    await writeBaseAgent(
      'base-coder',
      `---
model: claude-sonnet-4
---
Write clean TypeScript code.
`,
    );

    const agents: AgentDefinition[] = [
      { name: 'ts-coder', extends: 'base-coder', description: 'TypeScript specialist' },
    ];
    const result = await resolveAgents(agents, mkCtx());
    expect(result[0]).toHaveProperty('systemPrompt', 'Write clean TypeScript code.');
    expect(result[0]).toHaveProperty('description', 'TypeScript specialist');
    expect(result[0]).toHaveProperty('model', 'claude-sonnet-4');
  });

  it('[AR-022] skillsMerge "append" accumulates base and override skills deduped', async () => {
    await writeBaseAgent(
      'base-with-skills',
      `---
skills:
  - typescript
  - relay-monorepo
---
`,
    );

    const agents: AgentDefinition[] = [
      {
        name: 'extended',
        extends: 'base-with-skills',
        skills: ['vitest', 'typescript'],
        skillsMerge: 'append',
      },
    ];
    const result = await resolveAgents(agents, mkCtx());
    const skills = result[0].skills as string[];
    expect(skills).toContain('typescript');
    expect(skills).toContain('relay-monorepo');
    expect(skills).toContain('vitest');
    // deduped — typescript appears only once
    expect(skills.filter((s) => s === 'typescript')).toHaveLength(1);
  });

  it('[AR-023] skillsMerge "replace" (default) replaces base skills with override skills', async () => {
    await writeBaseAgent(
      'base-skills-replace',
      `---
skills:
  - typescript
  - relay-monorepo
---
`,
    );

    const agents: AgentDefinition[] = [
      {
        name: 'replaced',
        extends: 'base-skills-replace',
        skills: ['vitest'],
        // skillsMerge omitted → defaults to replace
      },
    ];
    const result = await resolveAgents(agents, mkCtx());
    const skills = result[0].skills as string[];
    expect(skills).toEqual(['vitest']);
    expect(skills).not.toContain('typescript');
    expect(skills).not.toContain('relay-monorepo');
  });

  it('[AR-024] throws AgentsResolutionError(reason: extends-not-found) when base .md is absent', async () => {
    const agents: AgentDefinition[] = [{ name: 'orphan', extends: 'nonexistent-base' }];
    await expect(resolveAgents(agents, mkCtx())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AgentsResolutionError && e.details?.reason === 'extends-not-found',
    );
  });

  it('[AR-025] throws AgentsResolutionError(reason: frontmatter-parse-error) on malformed YAML', async () => {
    // gray-matter handles most malformed YAML gracefully; we need to trigger a real parse error.
    // Construct YAML that causes gray-matter to throw: use a tab character inside a block mapping
    // which is a YAML spec violation that some parsers reject.
    await writeBaseAgent(
      'bad-frontmatter',
      `---
key: value
  indented: bad: : : colon overload that trips strict YAML parsers: [unclosed
---
`,
    );

    // gray-matter with js-yaml will throw on certain malformed inputs.
    // If this agent passes as ok, we need a harder YAML error.
    // Use a known-bad construction: a bare tab character as a mapping key
    const agentsDir = join(flowDir, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    // Write truly broken YAML: mismatched block sequence that gray-matter/js-yaml rejects
    await writeFile(
      join(agentsDir, 'truly-bad.md'),
      '---\n{invalid yaml: [unclosed bracket\n---\nbody\n',
      'utf8',
    );

    const agents: AgentDefinition[] = [{ name: 'bad-agent', extends: 'truly-bad' }];
    await expect(resolveAgents(agents, mkCtx())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AgentsResolutionError && e.details?.reason === 'frontmatter-parse-error',
    );
  });
});

// ---------------------------------------------------------------------------
// Group 4: Duplicate name detection
// ---------------------------------------------------------------------------

describe('resolveAgents — duplicate-name', () => {
  it('[AR-030] throws AgentsResolutionError(reason: duplicate-name) for two entries sharing a name', async () => {
    const agents: AgentDefinition[] = [
      { name: 'reviewer', systemPrompt: 'First.' },
      { name: 'reviewer', systemPrompt: 'Duplicate.' },
    ];
    await expect(resolveAgents(agents, mkCtx())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AgentsResolutionError &&
        e.details?.reason === 'duplicate-name' &&
        typeof e.message === 'string' &&
        e.message.includes('reviewer'),
    );
  });

  it('[AR-031] three entries where third duplicates first also triggers duplicate-name', async () => {
    const agents: AgentDefinition[] = [
      { name: 'alpha', systemPrompt: 'Alpha.' },
      { name: 'beta', systemPrompt: 'Beta.' },
      { name: 'alpha', systemPrompt: 'Alpha again.' },
    ];
    await expect(resolveAgents(agents, mkCtx())).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentsResolutionError && e.details?.reason === 'duplicate-name',
    );
  });
});
