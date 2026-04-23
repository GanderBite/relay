import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted shared state so the vi.mock factory for ./resume.js can hand the
// Orchestrator a real Flow object without touching disk. Tests set `flowFixture` to
// the Flow they want resumed and `flowRefOverride` to the flow-ref payload
// that load path should surface. Mocking avoids writing a compiled flow
// module to /tmp just to exercise the status-gate branches.
const mocks = vi.hoisted(() => ({
  flowFixture: null as null | unknown,
  flowRefOverride: null as null | { flowName: string; flowVersion: string; flowPath: string },
}));

vi.mock('../../src/orchestrator/resume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/orchestrator/resume.js')>();
  return {
    ...actual,
    loadFlowRef: async () => {
      if (mocks.flowRefOverride === null) {
        return actual.loadFlowRef('__not_used__');
      }
      const { ok: okResult } = await import('neverthrow');
      return okResult(mocks.flowRefOverride);
    },
    importFlow: async () => {
      if (mocks.flowFixture === null) {
        throw new Error('flowFixture not set by test');
      }
      return mocks.flowFixture;
    },
  };
});

import type { PipelineError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import type { RunState, StepState } from '../../src/flow/types.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type {
  AuthState,
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../../src/providers/types.js';
import { z } from '../../src/zod.js';

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['mock-model'],
  maxContextTokens: 200_000,
};

const canned: InvocationResponse = {
  // Handoff outputs parse text as JSON; keep the canned body syntactically
  // valid so the re-dispatch path settles with handoff persistence rather
  // than tripping HandoffSchemaError before any state transition lands.
  text: '{"ok":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock-model',
  stopReason: 'end_turn',
};

/**
 * Spy provider that records every invoke() call by stepId. Tests assert on
 * `invokedSteps` to prove which branches dispatched — a clean signal that
 * the succeeded short-circuit did not re-run any step while the other
 * branches did.
 */
class RecordingProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  readonly invokedSteps: string[] = [];

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'mock provider' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokedSteps.push(ctx.stepId);
    return ok(canned);
  }
}

function twoStepFlow() {
  return defineFlow({
    name: 'resume-gate-flow',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      a: step.prompt({
        promptFile: 'p.md',
        output: { handoff: 'a-out' },
      }),
      b: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['a'],
        output: { handoff: 'b-out' },
      }),
    },
  });
}

async function writeStateFile(
  runDir: string,
  status: RunState['status'],
  steps: Record<string, StepState>,
): Promise<void> {
  const payload: RunState = {
    runId: 'r-gate',
    flowName: 'resume-gate-flow',
    flowVersion: '0.1.0',
    status,
    startedAt: '2026-04-19T00:00:00.000Z',
    updatedAt: '2026-04-19T00:00:05.000Z',
    input: {},
    steps,
  };
  await writeFile(join(runDir, 'state.json'), JSON.stringify(payload), 'utf8');
}

describe('Orchestrator.resume() — persisted status gate', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-resume-gate-'));
    mocks.flowFixture = twoStepFlow();
    mocks.flowRefOverride = {
      flowName: 'resume-gate-flow',
      flowVersion: '0.1.0',
      flowPath: join(tmp, 'flow.stub.js'),
    };
    // The prompt executor reads promptFile from disk relative to flowDir;
    // resume defaults flowDir to dirname(flowPath), which is `tmp` here.
    // Write a no-op template so the re-dispatch path does not trip on ENOENT
    // before reaching the mock provider.
    await writeFile(join(tmp, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    mocks.flowFixture = null;
    mocks.flowRefOverride = null;
  });

  it('succeeded: short-circuits and rebuilds RunResult without re-running steps', async () => {
    await writeStateFile(tmp, 'succeeded', {
      a: {
        status: 'succeeded',
        attempts: 1,
        startedAt: '2026-04-19T00:00:01.000Z',
        completedAt: '2026-04-19T00:00:02.000Z',
        artifacts: ['out/a.md'],
      },
      b: {
        status: 'succeeded',
        attempts: 1,
        startedAt: '2026-04-19T00:00:03.000Z',
        completedAt: '2026-04-19T00:00:04.000Z',
        artifacts: ['out/b.md'],
      },
    });
    await writeFile(
      join(tmp, 'metrics.json'),
      JSON.stringify([
        {
          stepId: 'a',
          flowName: 'resume-gate-flow',
          runId: 'r-gate',
          timestamp: '2026-04-19T00:00:02.000Z',
          model: 'mock-model',
          tokensIn: 10,
          tokensOut: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          numTurns: 1,
          durationMs: 10,
          costUsd: 0.05,
        },
      ]),
      'utf8',
    );

    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.resume(tmp, { flagProvider: 'mock' });

    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe('r-gate');
    expect(result.cost.totalUsd).toBeCloseTo(0.05);
    expect(result.cost.totalTokens).toBe(15);
    expect(result.artifacts).toEqual(expect.arrayContaining(['out/a.md', 'out/b.md']));
    expect(result.durationMs).toBe(5_000);
    // The short-circuit must not authenticate, walk the DAG, or invoke any
    // step. A single invoke call here would mean a wasted prompt on an
    // already-complete run.
    expect(provider.invokedSteps).toEqual([]);
  });

  it('aborted: continues resume and re-dispatches the aborted step', async () => {
    // Simulate a clean ctrl-c: markRun('aborted') swept the running step to
    // failed with errorMessage 'run aborted' before the process exited.
    // Resume must reset that step to pending and re-dispatch it.
    await writeStateFile(tmp, 'aborted', {
      a: {
        status: 'failed',
        attempts: 1,
        startedAt: '2026-04-19T00:00:01.000Z',
        completedAt: '2026-04-19T00:00:02.000Z',
        errorMessage: 'run aborted',
      },
      b: { status: 'pending', attempts: 0 },
    });

    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.resume(tmp, { flagProvider: 'mock' });

    expect(result.status).toBe('succeeded');
    expect(provider.invokedSteps).toEqual(['a', 'b']);
    const finalState: RunState = JSON.parse(await readFile(join(tmp, 'state.json'), 'utf8'));
    expect(finalState.status).toBe('succeeded');
    expect(finalState.steps.a.status).toBe('succeeded');
    expect(finalState.steps.b.status).toBe('succeeded');
  });

  it('failed: continues resume and re-runs the failed step', async () => {
    await writeStateFile(tmp, 'failed', {
      a: {
        status: 'failed',
        attempts: 1,
        startedAt: '2026-04-19T00:00:01.000Z',
        completedAt: '2026-04-19T00:00:02.000Z',
        errorMessage: 'transient',
      },
      b: { status: 'pending', attempts: 0 },
    });

    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.resume(tmp, { flagProvider: 'mock' });

    expect(result.status).toBe('succeeded');
    expect(provider.invokedSteps).toEqual(['a', 'b']);
  });

  it('running: sweeps the zombie step to failed, resets to pending, and re-runs', async () => {
    // Simulate a SIGKILL that bypassed markRun(): state.json has status=
    // 'running' and a step stuck in 'running' with no in-flight executor.
    // The FLAG-12 sweep plus the existing failed -> pending pass must
    // recover the step; the gate's 'running' arm intentionally falls through
    // to that recovery path.
    await writeStateFile(tmp, 'running', {
      a: {
        status: 'running',
        attempts: 1,
        startedAt: '2026-04-19T00:00:01.000Z',
      },
      b: { status: 'pending', attempts: 0 },
    });

    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.resume(tmp, { flagProvider: 'mock' });

    expect(result.status).toBe('succeeded');
    expect(provider.invokedSteps).toEqual(['a', 'b']);
    const finalState: RunState = JSON.parse(await readFile(join(tmp, 'state.json'), 'utf8'));
    expect(finalState.steps.a.status).toBe('succeeded');
  });
});
