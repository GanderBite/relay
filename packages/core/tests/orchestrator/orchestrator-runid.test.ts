import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

const canned: InvocationResponse = {
  text: '{}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function twoStepFlow() {
  return defineFlow({
    name: 'runid-test',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } }),
      b: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['a'],
        output: { handoff: 'b-out' },
      }),
    },
  });
}

describe('runId / runDir consistency contract', () => {
  const tmps: string[] = [];

  afterEach(async () => {
    for (const d of tmps.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function makeTmp(prefix = 'relay-runid-') {
    const d = await mkdtemp(join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  }

  function makeProvider() {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider({ responses: { a: canned, b: canned } }));
    return registry;
  }

  it('[RUNID-001] no runDir override — state.runId equals basename(runDir) and is a 6-char hex string', async () => {
    const flowDir = await makeTmp('relay-runid-fdir-');
    await writeFile(join(flowDir, 'p.md'), '# test', 'utf8');

    const registry = makeProvider();
    const orchestrator = createOrchestrator({ providers: registry });

    const result = await orchestrator.run(
      twoStepFlow(),
      {},
      {
        flowDir,
        authTimeoutMs: 1_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    expect(result.status).toBe('succeeded');

    const expectedRunId = basename(result.runDir);
    expect(result.runId).toBe(expectedRunId);

    const stateRaw = await readFile(join(result.runDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as { runId: string };
    expect(state.runId).toBe(expectedRunId);

    // shortRunId() is hex(randomBytes(3)) — always exactly 6 hex chars
    expect(state.runId).toMatch(/^[0-9a-f]{6}$/);

    // clean up the auto-created run dir
    tmps.push(result.runDir);
  });

  it('[RUNID-002] runDir override — state.runId equals basename of the overridden directory', async () => {
    const base = await makeTmp('relay-runid-base-');
    const overrideDir = join(base, 'my-custom-run');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(base, 'p.md'), '# test', 'utf8');

    const registry = makeProvider();
    const orchestrator = createOrchestrator({ providers: registry, runDir: overrideDir });

    const result = await orchestrator.run(
      twoStepFlow(),
      {},
      {
        flowDir: base,
        authTimeoutMs: 1_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.runDir).toBe(overrideDir);
    expect(result.runId).toBe('my-custom-run');

    const stateRaw = await readFile(join(overrideDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as { runId: string };
    expect(state.runId).toBe('my-custom-run');
    expect(state.runId).toBe(basename(overrideDir));
  });

  it('[RUNID-003] override with an arbitrary basename — any directory name is accepted as the runId', async () => {
    const base = await makeTmp('relay-runid-arb-');
    const customName = 'sprint-33-run-abc';
    const overrideDir = join(base, customName);
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(base, 'p.md'), '# test', 'utf8');

    const registry = makeProvider();
    const orchestrator = createOrchestrator({ providers: registry, runDir: overrideDir });

    const result = await orchestrator.run(
      twoStepFlow(),
      {},
      {
        flowDir: base,
        authTimeoutMs: 1_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe(customName);
    expect(result.runDir).toBe(overrideDir);

    const stateRaw = await readFile(join(overrideDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as { runId: string };
    expect(state.runId).toBe(customName);
    expect(state.runId).toBe(basename(overrideDir));
  });
});
