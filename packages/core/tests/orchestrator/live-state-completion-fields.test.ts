/**
 * Regression test for FLAG-1 from sprint 53 review.
 *
 * The terminal writeLiveState calls (status: 'succeeded' | 'failed' | 'paused')
 * in step-dispatch must preserve the per-kind metadata — `maxIter` for loop
 * steps and `branchCount` for parallel steps — the same way the running write
 * does. atomicWriteJson is last-write-wins (full file replace), so without the
 * preservation the live JSON loses fields after completion and the watcher
 * forwards undefined to the renderer.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

const IMPL_DONE: InvocationResponse = {
  text: '{"done":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('writeLiveState — succeeded write preserves per-kind metadata', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-live-completion-'));
    await writeFile(join(FIXTURES_DIR, 'p.md'), '# test prompt', 'utf8');
    await mkdir(join(tmp, 'live'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loop step: succeeded live JSON retains maxIter and carries final iter', async () => {
    const flow = defineFlow({
      name: 'loop-completion-fields',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        fix_loop: step.loop({
          body: {
            implement: step.prompt({
              promptFile: 'p.md',
              output: { handoff: 'implementation' },
            }),
          },
          until: { from: 'implementation', when: { done: true } },
          maxIterations: 7,
        }),
      },
    });

    const provider = new MockProvider({ responses: { implement: IMPL_DONE } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(flow, {}, { flowDir: FIXTURES_DIR, ...RUN_OPTS });

    expect(result.status).toBe('succeeded');

    const raw = await readFile(join(tmp, 'live', 'fix_loop.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['status']).toBe('succeeded');
    // maxIter must survive the succeeded write — without the conditional
    // spread fix in step-dispatch, atomicWriteJson would clobber it.
    expect(parsed['maxIter']).toBe(7);
    // The final iter count from LoopStepResult.iterations is carried through
    // so the completed loop row reads `iter 1/7` instead of falling back to 1.
    expect(parsed['iter']).toBe(1);
  });

  it('parallel step: succeeded live JSON retains branchCount', async () => {
    const flow = defineFlow({
      name: 'parallel-completion-fields',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        fan: step.parallel({ branches: ['a', 'b', 'c'] }),
        a: step.terminal({}),
        b: step.terminal({}),
        c: step.terminal({}),
      },
    });

    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(flow, {}, { flowDir: FIXTURES_DIR, ...RUN_OPTS });

    expect(result.status).toBe('succeeded');

    const raw = await readFile(join(tmp, 'live', 'fan.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['status']).toBe('succeeded');
    expect(parsed['branchCount']).toBe(3);
  });
});
