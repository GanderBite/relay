/**
 * Regression test for the streaming usage accumulator.
 *
 * The wire emits multiple partial usage envelopes per step. This test verifies
 * that per-step token counters are monotonically non-decreasing across all
 * writeLiveState calls, and that the final response.usage.outputTokens equals
 * the sum of all partial deltas rather than the last replacement value.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the spy so vi.mock can close over it and so tests can reference it.
const writeLiveStateSpy = vi.hoisted(() => vi.fn());

// The real implementation reference, captured by importOriginal.
const realImpl = vi.hoisted(() => ({
  fn: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('../../../src/orchestrator/live-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/orchestrator/live-state.js')>();
  realImpl.fn = actual.writeLiveState as (...args: unknown[]) => unknown;
  writeLiveStateSpy.mockImplementation((...args: unknown[]) => {
    if (realImpl.fn !== null) return realImpl.fn(...args);
    return { isOk: () => true, isErr: () => false, value: undefined };
  });
  return {
    ...actual,
    writeLiveState: writeLiveStateSpy,
  };
});

import { ok, type Result } from 'neverthrow';
import { CostTracker } from '../../../src/cost.js';
import type { PipelineError } from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import { executePrompt } from '../../../src/orchestrator/exec/prompt.js';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  Provider,
  ProviderCapabilities,
} from '../../../src/providers/types.js';

/**
 * A provider that emits a fixed four-envelope stream matching the wire format
 * described in the task description:
 *   message_start  { inputTokens: 25 }
 *   message_delta  { outputTokens: 1000 }
 *   message_delta  { outputTokens: 100 }
 *   result         { inputTokens: 25, outputTokens: 5000 }
 *
 * A text.delta is emitted before the first usage envelope so the liveness ping
 * in runProviderInvocation fires and populates the initial writeLiveState call.
 *
 * With correct summing semantics the accumulated usage after all four envelopes
 * must be:
 *   inputTokens:  0 + 25 + 0 + 0 + 25 = 50
 *   outputTokens: 0 + 0 + 1000 + 100 + 5000 = 6100
 *
 * tokensSoFar at each usage event:
 *   after message_start: 25 + 0 = 25
 *   after message_delta(1000): 25 + 1000 = 1025
 *   after message_delta(100):  25 + 1100 = 1125
 *   after result:              50 + 6100 = 6150
 */
class FourEnvelopeProvider implements Provider {
  readonly name = 'four-envelope' as const;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    structuredOutput: false,
    tools: false,
    builtInTools: [],
    multimodal: false,
    budgetCap: false,
    supportsAgents: false,
    models: ['mock'],
    maxContextTokens: 200_000,
  };

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true as const, billingSource: 'local' as const, detail: 'mock' });
  }

  async invoke(
    _req: InvocationRequest,
    _ctx: InvocationContext,
  ): Promise<Result<never, PipelineError>> {
    // Stream-capable provider — invoke() is unreachable in this test.
    throw new Error('FourEnvelopeProvider: invoke() must not be called when stream() is present');
  }

  async *stream(_req: InvocationRequest, _ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    // Liveness ping — fires before any usage event so tokensSoFar starts at 0.
    yield { type: 'text.delta', delta: 'response text' };

    // Envelope 1: message_start carries input_tokens only.
    yield { type: 'usage', usage: { inputTokens: 25 } };

    // Envelope 2: message_delta carries a large output_tokens partial.
    yield { type: 'usage', usage: { outputTokens: 1000 } };

    // Envelope 3: message_delta carries a smaller output_tokens partial.
    yield { type: 'usage', usage: { outputTokens: 100 } };

    // Envelope 4: result carries cumulative totals.
    yield { type: 'usage', usage: { inputTokens: 25, outputTokens: 5000 } };

    yield { type: 'stream.end', stopReason: 'end_turn' };
  }
}

describe('executePrompt — usage accumulator monotonic-non-decreasing', () => {
  let tmp: string;
  let flowDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-usage-mono-'));
    flowDir = join(tmp, 'flow');
    await mkdir(join(flowDir, 'prompts'), { recursive: true });
    await writeFile(join(flowDir, 'prompts', 'p.md'), 'Hello world', 'utf8');

    writeLiveStateSpy.mockImplementation((...args: unknown[]) => {
      if (realImpl.fn !== null) return realImpl.fn(...args);
      return { isOk: () => true, isErr: () => false, value: undefined };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it('[USAGE-MONO-001] tokensSoFar is monotonically non-decreasing across all writeLiveState calls', async () => {
    const provider = new FourEnvelopeProvider();
    const handoffStore = new HandoffStore(tmp);
    const costTracker = new CostTracker(join(tmp, 'metrics.json'));
    const logger = createLogger({ flowName: 'f', runId: 'r' });

    // The mock provider does not write a handoff file; provide a schemaless
    // handoff step so executePrompt uses the extractJson path on response.text.
    // FourEnvelopeProvider yields 'response text' which is not JSON, so we
    // use an artifact output instead to avoid a handoff parse error.
    const sArtifact = step.prompt({
      promptFile: 'prompts/p.md',
      output: { artifact: 'out.txt' },
    });
    const artifactStepId = sArtifact.id || 'pa';

    const ctx = {
      runDir: tmp,
      flowDir,
      flowName: 'f',
      runId: 'r',
      stepId: artifactStepId,
      attempt: 1,
      abortSignal: new AbortController().signal,
      handoffStore,
      costTracker,
      logger,
      provider,
    };

    await executePrompt(sArtifact, ctx);

    // Collect all writeLiveState calls for this step that carry tokensSoFar.
    type PartialState = { tokensSoFar?: unknown };
    const tokensSoFarValues: number[] = writeLiveStateSpy.mock.calls
      .filter(
        ([_runDir, sid, partial]) =>
          sid === artifactStepId && typeof (partial as PartialState).tokensSoFar === 'number',
      )
      .map(([_runDir, _sid, partial]) => (partial as PartialState).tokensSoFar as number);

    // Must have observed at least the four usage events.
    expect(tokensSoFarValues.length).toBeGreaterThanOrEqual(4);

    // Every value must be >= the previous value (monotonically non-decreasing).
    for (let i = 1; i < tokensSoFarValues.length; i++) {
      const prev = tokensSoFarValues[i - 1];
      const curr = tokensSoFarValues[i];
      if (prev === undefined || curr === undefined) continue;
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('[USAGE-MONO-002] final response.usage.outputTokens equals the sum of all output deltas (6100)', async () => {
    const sArtifact = step.prompt({
      promptFile: 'prompts/p.md',
      output: { artifact: 'out.txt' },
    });
    const artifactStepId = sArtifact.id || 'pa';

    const provider = new FourEnvelopeProvider();
    const handoffStore = new HandoffStore(tmp);
    const costTracker = new CostTracker(join(tmp, 'metrics.json'));
    const logger = createLogger({ flowName: 'f', runId: 'r' });

    const ctx = {
      runDir: tmp,
      flowDir,
      flowName: 'f',
      runId: 'r',
      stepId: artifactStepId,
      attempt: 1,
      abortSignal: new AbortController().signal,
      handoffStore,
      costTracker,
      logger,
      provider,
    };

    const result = await executePrompt(sArtifact, ctx);

    // The summing accumulator must yield 1000 + 100 + 5000 = 6100, not the
    // replacement value of the last envelope alone (5000).
    expect(result.tokensOut).toBe(6100);
  });
});
