/**
 * Contract tests for the per-usage-event live-state cadence in executePrompt.
 *
 * Each prompt step must rewrite <runDir>/live/<stepId>.json on every token-
 * usage event the provider emits, not just once at the end of the invocation.
 * The CLI progress display watches this file to animate token/turn counters
 * within a single long-running prompt step.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../../../src/cost.js';
import type { PipelineError } from '../../../src/errors.js';
import type { PromptStepSpec } from '../../../src/flow/types.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import { executePrompt } from '../../../src/orchestrator/exec/prompt.js';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../../../src/providers/types.js';

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: false,
  builtInTools: [],
  multimodal: false,
  budgetCap: false,
  models: ['mock-model'],
  maxContextTokens: 200_000,
};

/**
 * Builds a Provider whose stream() yields a caller-supplied event sequence.
 * The stock MockProvider emits exactly one usage event per invocation which
 * is not enough to pin the per-event cadence — this helper lets a test emit
 * any number of usage events interleaved with text deltas and turn markers.
 */
function scriptedProvider(
  events: readonly InvocationEvent[],
  text: string,
  onEventEmitted?: (event: InvocationEvent) => Promise<void> | void,
): Provider {
  return {
    name: 'scripted-stream',
    capabilities: CAPABILITIES,
    async authenticate(): Promise<Result<AuthState, PipelineError>> {
      return ok({ ok: true, billingSource: 'local', detail: 'scripted stream' });
    },
    async invoke(
      _req: InvocationRequest,
      _ctx: InvocationContext,
    ): Promise<Result<InvocationResponse, PipelineError>> {
      return ok({
        text,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        durationMs: 0,
        numTurns: 1,
        model: 'mock-model',
        stopReason: 'end_turn',
      });
    },
    async *stream(
      _req: InvocationRequest,
      _ctx: InvocationContext,
    ): AsyncIterable<InvocationEvent> {
      for (const event of events) {
        yield event;
        if (onEventEmitted !== undefined) {
          await onEventEmitted(event);
        }
      }
    },
  };
}

function promptSpec(id: string, artifactName: string): PromptStepSpec {
  return {
    id,
    kind: 'prompt',
    promptFile: 'prompts/p.md',
    output: { artifact: artifactName },
  };
}

describe('executePrompt live-state cadence', () => {
  let tmp: string;
  let flowDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-live-cadence-'));
    flowDir = join(tmp, 'flow');
    await mkdir(join(flowDir, 'prompts'), { recursive: true });
    await writeFile(join(flowDir, 'prompts', 'p.md'), 'Hello', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeCtxBase() {
    const handoffStore = new HandoffStore(tmp);
    const costTracker = new CostTracker(join(tmp, 'metrics.json'));
    return {
      runDir: tmp,
      flowDir,
      flowName: 'f',
      runId: 'r',
      handoffStore,
      costTracker,
      logger: createLogger({ flowName: 'f', runId: 'r' }),
      abortSignal: new AbortController().signal,
    };
  }

  it('writes at least two live-state snapshots when the provider emits two usage events', async () => {
    const stepId = 'greet';
    const events: InvocationEvent[] = [
      { type: 'turn.start', turn: 1 },
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
      { type: 'turn.end', turn: 1 },
    ];

    // Sampling the live file between yielded events (instead of after the whole
    // stream ends) is what distinguishes "per-event" from "end-of-call" writes.
    // A writer that only runs once at the end would leave the live file
    // untouched between yields, and `observed` would hold identical values.
    const observed: number[] = [];
    const provider = scriptedProvider(events, '', async (event) => {
      if (event.type !== 'usage') return;
      const raw = await readFile(join(tmp, 'live', `${stepId}.json`), 'utf8').catch(() => null);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as { tokensSoFar?: number };
      if (typeof parsed.tokensSoFar === 'number') {
        observed.push(parsed.tokensSoFar);
      }
    });

    const step = promptSpec(stepId, 'out.txt');
    const ctx = {
      ...makeCtxBase(),
      stepId,
      provider,
      attempt: 1,
    };
    await executePrompt(step, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed[0]).toBe(5);
    expect(observed[observed.length - 1]).toBe(10);
  });

  it('updates tokensSoFar cumulatively across usage events and persists the aggregated text', async () => {
    const stepId = 'aggregate';
    const fragments = ['{"ok":', 'true}'];
    const events: InvocationEvent[] = [
      { type: 'turn.start', turn: 1 },
      { type: 'text.delta', delta: fragments[0]! },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      { type: 'text.delta', delta: fragments[1]! },
      {
        type: 'usage',
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      { type: 'turn.end', turn: 1 },
    ];

    const tokenSeries: number[] = [];
    const provider = scriptedProvider(events, fragments.join(''), async (event) => {
      if (event.type !== 'usage') return;
      const raw = await readFile(join(tmp, 'live', `${stepId}.json`), 'utf8').catch(() => null);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as { tokensSoFar?: number };
      if (typeof parsed.tokensSoFar === 'number') tokenSeries.push(parsed.tokensSoFar);
    });

    const step = promptSpec(stepId, 'out.json');
    const ctx = {
      ...makeCtxBase(),
      stepId,
      provider,
      attempt: 1,
    };
    await executePrompt(step, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(tokenSeries).toEqual([15, 30]);

    // Final on-disk file reflects the last usage snapshot and carries the
    // 'running' status — executePrompt never writes a terminal live-state; the
    // Step is responsible for the success/failure write-back.
    const finalRaw = await readFile(join(tmp, 'live', `${stepId}.json`), 'utf8');
    const final = JSON.parse(finalRaw) as {
      status: string;
      tokensSoFar: number;
      toolsSoFar: number;
    };
    expect(final.tokensSoFar).toBe(30);
    expect(final.status).toBe('running');
    expect(final.toolsSoFar).toBe(0);

    // Aggregated stream text still lands as the artifact file. If the aggregator
    // were skipping text.delta events the artifact would be empty.
    const artifactStat = await stat(join(tmp, 'artifacts', 'out.json'));
    expect(artifactStat.isFile()).toBe(true);
    const artifact = await readFile(join(tmp, 'artifacts', 'out.json'), 'utf8');
    expect(artifact).toBe(fragments.join(''));
  });

  it('increments toolsSoFar once per tool.call event and persists the count in the live JSON', async () => {
    // Regression guard: a future change that reverts to counting turn.end instead
    // of tool.call would produce toolsSoFar: 0 here and fail this test.
    const stepId = 'tool-count';
    const events: InvocationEvent[] = [
      { type: 'turn.start', turn: 1 },
      { type: 'tool.call', name: 'read_file', toolUseId: 'call_1' },
      { type: 'tool.call', name: 'write_file', toolUseId: 'call_2' },
      { type: 'tool.call', name: 'bash', toolUseId: 'call_3' },
      { type: 'text.delta', delta: 'done' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
      { type: 'turn.end', turn: 1 },
    ];

    const provider = scriptedProvider(events, 'done');

    const step = promptSpec(stepId, 'out.txt');
    const ctx = {
      ...makeCtxBase(),
      stepId,
      provider,
      attempt: 1,
    };
    await executePrompt(step, ctx as unknown as Parameters<typeof executePrompt>[1]);

    const finalRaw = await readFile(join(tmp, 'live', `${stepId}.json`), 'utf8');
    const final = JSON.parse(finalRaw) as { toolsSoFar: number };
    expect(final.toolsSoFar).toBe(3);
  });
});
