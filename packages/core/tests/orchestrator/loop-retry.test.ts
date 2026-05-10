/**
 * Orchestrator-level regression test for the loop-step retry path.
 *
 * Scenario: a loop step is configured with `maxRetries: 1`. Its body has a
 * single non-ask prompt step that throws on the first invocation and
 * succeeds on the second. The fix has two moving parts:
 *
 * 1. The body step's executor throws a non-abort error → runBodyStep's
 *    catch failStep's the synthesised state entry to keep on-disk state
 *    consistent, then re-throws.
 * 2. executeLoop propagates the throw → withRetry retries → executeLoop
 *    re-enters at iter 1 → runBodyStep re-runs → seedBodyStep observes the
 *    same-iter failed entry and normalises it back to pending so startStep
 *    succeeds on the second attempt.
 *
 * Without the seedBodyStep normalisation, the second startStep call would
 * trip "cannot start step "<loop>::<body>" from status "failed"" and the
 * run would return failed instead of succeeded — the deadlock the new
 * regression closes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type {
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
} from '../../src/providers/types.js';
import { StateMachine } from '../../src/state.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

// implement returns {done:true} so the until condition matches and the loop
// exits after a single iteration when the body step actually succeeds.
const IMPL_DONE: InvocationResponse = {
  text: '{"done":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function makeLoopRetryFlow() {
  return defineFlow({
    name: 'loop-retry-flow',
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
        maxRetries: 1,
      }),
    },
  });
}

describe('orchestrator — loop step retry recovers from a non-ask body step failure', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-loop-retry-'));
    await writeFile(join(FIXTURES_DIR, 'p.md'), '# test prompt', 'utf8');
    await mkdir(join(tmp, 'live'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('retries the loop after a non-ask body step throws on the first attempt', async () => {
    let implementCalls = 0;
    const implementSpy = vi.fn(
      (_req: InvocationRequest, _ctx: InvocationContext): InvocationResponse => {
        implementCalls += 1;
        if (implementCalls === 1) {
          throw new Error('first attempt blew up');
        }
        return IMPL_DONE;
      },
    );

    const provider = new MockProvider({ responses: { implement: implementSpy } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    const result = await orchestrator.run(
      makeLoopRetryFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
      },
    );

    // Without the seedBodyStep normalisation, the retry's startStep on the
    // synthesised key trips StateTransitionError and the run lands at
    // 'failed'. With the fix, the retry succeeds end to end.
    expect(result.status).toBe('succeeded');

    // implement was invoked twice: throw on attempt 1, success on attempt 2.
    expect(implementCalls).toBe(2);

    // No transition error must surface on the run-level RunResult.
    expect(result.firstError?.name ?? '').not.toBe('StateTransitionError');
  });

  it('records the loop step attempts counter at 1 after one retry; body entry at succeeded', async () => {
    let implementCalls = 0;
    const provider = new MockProvider({
      responses: {
        implement: () => {
          implementCalls += 1;
          if (implementCalls === 1) throw new Error('first attempt blew up');
          return IMPL_DONE;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    const result = await orchestrator.run(
      makeLoopRetryFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
      },
    );

    expect(result.status).toBe('succeeded');

    // Read the on-disk state to assert per-step shape — RunResult does not
    // surface the steps map directly.
    const raw = await readFile(join(tmp, 'state.json'), 'utf8');
    const state = JSON.parse(raw) as {
      steps: Record<string, { status: string; attempts: number; iter?: number }>;
    };

    // The loop step itself dispatches once; withRetry handles the retry
    // inside that single dispatch. startStep increments attempts to 1 at
    // dispatch time and the executor's internal retry does not touch the
    // outer attempts counter, so the loop's persisted attempts is 1.
    const loopState = state.steps['fix_loop'];
    expect(loopState?.status).toBe('succeeded');
    expect(loopState?.attempts).toBe(1);

    // The body step's synthesised entry should be at succeeded with iter=1.
    // attempts is 1 because seedBodyStep cleared it to 0 on the retry and
    // startStep bumped it to 1 for the second invocation.
    const bodyKey = StateMachine.bodyStepStateKey('fix_loop', 'implement');
    const bodyState = state.steps[bodyKey];
    expect(bodyState?.status).toBe('succeeded');
    expect(bodyState?.iter).toBe(1);
    expect(bodyState?.attempts).toBe(1);
  });
});
