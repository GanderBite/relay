import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the real writeLiveState before the mock replaces it. vi.hoisted
// runs before any import or vi.mock factory, so this slot is populated by
// the importOriginal call inside vi.mock below.
const realImpl = vi.hoisted(() => ({
  fn: null as null | ((...args: unknown[]) => unknown),
}));

// Spy that will replace writeLiveState in the mocked module. Hoisted so the
// vi.mock factory can close over it.
const writeLiveStateSpy = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => {
    // Delegate to the real implementation captured by importOriginal. The
    // beforeEach below also wires this, but having the delegation here means
    // the spy is safe to call even before the first beforeEach fires (e.g.
    // during module-level initialization).
    if (realImpl.fn !== null) {
      return realImpl.fn(..._args);
    }
    // Fallback: return a minimal neverthrow-compatible value so callers that
    // check isErr() do not crash. The orchestrator uses `void` for the
    // running write, so this path is only hit if there is a call before the
    // first beforeEach.
    return { isOk: () => true, isErr: () => false, value: undefined };
  }),
);

vi.mock('../../src/orchestrator/live-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/orchestrator/live-state.js')>();
  // Capture the original function so the spy can delegate to it.
  realImpl.fn = actual.writeLiveState as (...args: unknown[]) => unknown;
  return {
    ...actual,
    writeLiveState: writeLiveStateSpy,
  };
});

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
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('dispatchStep — writeLiveState running record', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-live-running-'));
    // The spy already delegates to realImpl.fn via its default implementation,
    // but clearAllMocks in afterEach resets the implementation. Re-wire it
    // here so each test starts with a transparent passthrough.
    writeLiveStateSpy.mockImplementation((...args: unknown[]) => {
      if (realImpl.fn !== null) {
        return realImpl.fn(...args);
      }
      return { isOk: () => true, isErr: () => false, value: undefined };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it('[LIVE-RUN-001] writes status:running for a terminal step before the executor resolves', async () => {
    // A terminal step is the simplest non-prompt step kind: it has no
    // provider invocation, resolves synchronously, and triggers the running
    // writeLiveState call added by task_159 in dispatchStep.
    const flow = defineFlow({
      name: 'terminal-live-state',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        done: step.terminal({}),
      },
    });

    // MockProvider is required even for terminal steps because the orchestrator
    // always resolves a provider before dispatching any step.
    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      flow,
      {},
      { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' },
    );

    expect(result.status).toBe('succeeded');

    // Collect all calls where stepId was 'done' and status was 'running'.
    const runningCalls = writeLiveStateSpy.mock.calls.filter(
      ([_runDir, stepId, partial]) =>
        stepId === 'done' && (partial as { status: string }).status === 'running',
    );

    expect(runningCalls.length).toBeGreaterThanOrEqual(1);

    const [_runDir, stepId, partial] = runningCalls[0]!;
    expect(stepId).toBe('done');
    expect((partial as { status: string }).status).toBe('running');
    expect((partial as { attempt: number }).attempt).toBeGreaterThanOrEqual(1);
    expect((partial as { startedAt: string }).startedAt).toBeTruthy();
    expect((partial as { lastUpdateAt: string }).lastUpdateAt).toBeTruthy();
  });

  it('[LIVE-RUN-002] running record is emitted before the succeeded record', async () => {
    // Verifies temporal ordering: the running call must appear in the mock's
    // call list strictly before the succeeded call for the same step.
    const flow = defineFlow({
      name: 'terminal-order-check',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        done: step.terminal({}),
      },
    });

    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    await orchestrator.run(flow, {}, { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' });

    // Index of the first 'running' call for step 'done'.
    const runningIdx = writeLiveStateSpy.mock.calls.findIndex(
      ([_rd, stepId, partial]) =>
        stepId === 'done' && (partial as { status: string }).status === 'running',
    );
    // Index of the first 'succeeded' call for step 'done'.
    const succeededIdx = writeLiveStateSpy.mock.calls.findIndex(
      ([_rd, stepId, partial]) =>
        stepId === 'done' && (partial as { status: string }).status === 'succeeded',
    );

    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(succeededIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(succeededIdx);
  });

  it('[LIVE-RUN-003] running record carries the correct runDir', async () => {
    const flow = defineFlow({
      name: 'terminal-rundir-check',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        done: step.terminal({}),
      },
    });

    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    await orchestrator.run(flow, {}, { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' });

    const runningCall = writeLiveStateSpy.mock.calls.find(
      ([_rd, stepId, partial]) =>
        stepId === 'done' && (partial as { status: string }).status === 'running',
    );

    expect(runningCall).toBeDefined();
    // The first argument must be the runDir the orchestrator was created with.
    expect(runningCall![0]).toBe(tmp);
  });

  it('[LIVE-RUN-004] prompt step also receives a running record before executor fires', async () => {
    // Confirm the running writeLiveState call fires before the provider invoke
    // for a prompt step. The call site is shared across all step kinds.
    await writeFile(join(tmp, 'p.md'), '# prompt', 'utf8');

    // Capture the count of 'running' calls for step 'greet' at the moment
    // the executor is invoked. If the running record is written before invoke,
    // this count must be >= 1.
    let runningCountAtInvocation = 0;
    const provider = new MockProvider({
      responses: {
        greet: () => {
          runningCountAtInvocation = writeLiveStateSpy.mock.calls.filter(
            ([_rd, stepId, partial]) =>
              stepId === 'greet' && (partial as { status: string }).status === 'running',
          ).length;
          return canned;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const flow = defineFlow({
      name: 'prompt-live-state',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        greet: step.prompt({ promptFile: 'p.md', output: { handoff: 'greet-out' } }),
      },
    });

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      flow,
      {},
      { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' },
    );

    expect(result.status).toBe('succeeded');
    // The executor recorded at least one running call before it was invoked.
    expect(runningCountAtInvocation).toBeGreaterThanOrEqual(1);
  });
});
