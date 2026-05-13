/**
 * Regression test for the terminal writeLiveState call added to runBodyStep
 * in step-dispatch.ts.
 *
 * Before the fix, a loop body step that completed successfully never received a
 * terminal live-state write. The CLI watcher's wasRunning && nowDone branch
 * therefore never fired and the body row stayed "running" forever, even after
 * the next iteration began. This test locks in the terminal writes so the
 * regression cannot recur silently.
 *
 * Covered scenarios:
 *   1. Successful body step — live/<bodyStepId>.json transitions to 'succeeded'.
 *   2. Failed body step (non-abort throw) — live/<bodyStepId>.json transitions
 *      to 'failed' when the body executor throws.
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

// Canned response that satisfies the until condition (done: true) so the loop
// exits after a single iteration.
const IMPL_DONE: InvocationResponse = {
  text: '{"done":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function makeLoopFlow() {
  return defineFlow({
    name: 'loop-body-live-state-flow',
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
        maxIterations: 3,
      }),
    },
  });
}

describe('runBodyStep — live-state terminal writes', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-body-live-'));
    await writeFile(join(FIXTURES_DIR, 'p.md'), '# test prompt', 'utf8');
    await mkdir(join(tmp, 'live'), { recursive: true });
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes status: succeeded to live/<bodyStepId>.json after body step completes', async () => {
    const provider = new MockProvider({ responses: { implement: IMPL_DONE } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      makeLoopFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
      },
    );

    expect(result.status).toBe('succeeded');

    // writeLiveState writes to live/<bodyStepId>.json where bodyStepId is
    // 'implement' (not the synthesised 'fix_loop::implement' key).
    const raw = await readFile(join(tmp, 'live', 'implement.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['status']).toBe('succeeded');
    // Belt-and-suspenders: must not still be at 'running' after run completes.
    expect(parsed['status']).not.toBe('running');
  });

  it('writes status: failed to live/<bodyStepId>.json when body executor throws', async () => {
    // The loop has maxRetries: 1 so the first attempt throws and the whole
    // loop step is retried. On the retry the body step succeeds. We only need
    // to confirm that the first failure wrote status: 'failed' at some point
    // — the second success overwrites it with 'succeeded', so we assert the
    // final terminal status from the file instead of racing the write.
    //
    // To observe a terminal 'failed' state (not immediately overwritten by a
    // retry's 'succeeded'), use maxRetries: 0 on the loop so the single
    // throw propagates all the way to a failed run.
    let implementCalls = 0;
    const provider = new MockProvider({
      responses: {
        implement: () => {
          implementCalls += 1;
          throw new Error('body step blew up');
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const failingFlow = defineFlow({
      name: 'loop-body-fail-live-state-flow',
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
          maxIterations: 3,
          maxRetries: 0,
        }),
      },
    });

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      failingFlow,
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
      },
    );

    expect(result.status).toBe('failed');
    // Body executor was invoked exactly once (no retries).
    expect(implementCalls).toBe(1);

    const raw = await readFile(join(tmp, 'live', 'implement.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['status']).toBe('failed');
    // Must not be stuck at 'running' after the run ends.
    expect(parsed['status']).not.toBe('running');
  });
});
