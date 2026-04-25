/**
 * TC-002: Partial parallel resume skips already-succeeded branches.
 *
 * A parallel step fans out to branchA and branchB. BranchA succeeded but
 * branchB failed, so the parent parallel step was marked failed. On resume(),
 * the parallel step is re-run but branchA must NOT be re-dispatched — only
 * branchB should be invoked.
 *
 * State machine flow on resume:
 *   1. All 'failed' steps are reset to 'pending' (parallel + branchB).
 *   2. seedReadyQueueForResume seeds the parallel step (entry is succeeded).
 *   3. executeParallel fires; getBranchStatus returns 'succeeded' for branchA
 *      → short-circuited without a dispatch call.
 *   4. getBranchStatus returns 'pending' for branchB → dispatched once.
 *   5. Both branches resolve; parallel completes; end is dispatched.
 *
 * This test uses direct state injection to pin the exact checkpoint, keeping
 * the assertion surface unambiguous.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineError } from '../../src/errors.js';
import type { RunState } from '../../src/flow/types.js';
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
import { atomicWriteJson } from '../../src/util/atomic-write.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

// ── shared constants ──────────────────────────────────────────────────────────

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const STEP_RESPONSE: InvocationResponse = {
  text: '{"ok":true}',
  usage: ZERO_USAGE,
  costUsd: 0,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['mock'],
  maxContextTokens: 200_000,
};

/**
 * Provider that tracks which steps it was asked to invoke. Succeeds on every
 * step it is called for, so resume can run to completion. Used to assert that
 * already-succeeded or skipped steps are never re-invoked after resume.
 */
class TrackingProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  readonly invokedSteps: string[] = [];

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'tracking mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokedSteps.push(ctx.stepId);
    return ok(STEP_RESPONSE);
  }

  async *stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    this.invokedSteps.push(ctx.stepId);
    yield { type: 'turn.start', turn: 1 };
    yield { type: 'text.delta', delta: '{"ok":true}' };
    yield { type: 'usage', usage: ZERO_USAGE };
    yield { type: 'turn.end', turn: 1 };
  }
}

// ── helper: write the boilerplate files a resumed run expects ─────────────────

/**
 * Write flow-ref.json and metrics.json stubs so resume() can locate and
 * re-import the flow and load cost data without encountering ENOENT.
 */
async function writeRunBoilerplate(
  runDir: string,
  flowName: string,
  flowVersion: string,
  flowPath: string,
): Promise<void> {
  await atomicWriteJson(join(runDir, 'flow-ref.json'), {
    flowName,
    flowVersion,
    flowPath,
  });
  // metrics.json must exist for CostTracker.load() inside resume().
  await atomicWriteJson(join(runDir, 'metrics.json'), []);
  // live/ directory must exist (clearLiveDir in run() creates it, but resume
  // does not call clearLiveDir — it inherits the directory from the prior run).
  await mkdir(join(runDir, 'live'), { recursive: true });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('TC-002: partial parallel resume skips already-succeeded branches', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-partial-parallel-resume-'));
    // Ensure the prompt template exists so executePrompt does not hit ENOENT.
    await writeFile(join(FIXTURES_DIR, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('resumes only branchB when branchA already succeeded; parallel step is not re-entered for branchA', {
    timeout: 20_000,
  }, async () => {
    const flowPath = join(FIXTURES_DIR, 'partial-parallel-resume-flow.ts');
    const flowName = 'partial-parallel-resume-flow';
    const flowVersion = '0.1.0';

    // ── Inject the partial-failure state ──────────────────────────────────
    // entry succeeded. The parallel step failed because branchB failed while
    // branchA had already succeeded. end is pending because the parallel
    // parent never completed.
    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-partial-parallel-01',
      flowName,
      flowVersion,
      status: 'failed',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        entry: {
          status: 'succeeded',
          attempts: 1,
          startedAt: now,
          completedAt: now,
          handoffs: ['entry-out'],
        },
        parallel: {
          status: 'failed',
          attempts: 1,
          startedAt: now,
          completedAt: now,
          errorMessage: 'parallel step "parallel" failed: 1 of 2 branch(es) failed',
        },
        branchA: {
          status: 'succeeded',
          attempts: 1,
          startedAt: now,
          completedAt: now,
          handoffs: ['branchA-out'],
        },
        branchB: {
          status: 'failed',
          attempts: 1,
          startedAt: now,
          completedAt: now,
          errorMessage: 'branchB failed on first attempt',
        },
        end: {
          status: 'pending',
          attempts: 0,
        },
      },
    };

    await writeRunBoilerplate(runDir, flowName, flowVersion, flowPath);
    await atomicWriteJson(join(runDir, 'state.json'), injectedState);

    // ── Resume ─────────────────────────────────────────────────────────────
    const trackingProvider = new TrackingProvider();
    const registry = new ProviderRegistry();
    registry.register(trackingProvider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir,
    });

    const result = await orchestrator.resume(runDir, {
      authTimeoutMs: 5_000,
      flowDir: FIXTURES_DIR,
      flagProvider: 'mock',
    });

    // ── Assertions ─────────────────────────────────────────────────────────

    // The resumed run must complete successfully.
    expect(result.status).toBe('succeeded');

    // branchB must have been invoked — it was the failing branch.
    expect(
      trackingProvider.invokedSteps,
      'branchB must be invoked on resume — it was the failed branch',
    ).toContain('branchB');

    // end must have been invoked — it was pending, waiting for the parallel step.
    expect(
      trackingProvider.invokedSteps,
      'end must be invoked on resume — it was pending',
    ).toContain('end');

    // branchA must NOT be re-invoked — it already succeeded on the first run.
    expect(
      trackingProvider.invokedSteps,
      'branchA must not be re-invoked — it already succeeded',
    ).not.toContain('branchA');

    // entry must NOT be re-invoked — it succeeded before the failure.
    expect(
      trackingProvider.invokedSteps,
      'entry must not be re-invoked — it already succeeded',
    ).not.toContain('entry');

    // Exactly one provider.invoke call for branchB (the parallel step itself
    // does not invoke the provider, and entry/branchA are skipped).
    expect(
      trackingProvider.invokedSteps.filter((id) => id === 'branchB').length,
      'branchB must be dispatched exactly once',
    ).toBe(1);

    // Verify the final persisted state matches the expected outcome.
    const finalStateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
    const finalState = JSON.parse(finalStateRaw) as RunState;

    expect(finalState.status).toBe('succeeded');

    // The parallel orchestrator step must now be succeeded.
    expect(finalState.steps.parallel?.status).toBe('succeeded');

    // branchA's attempt count must remain at 1 — it was never re-dispatched.
    expect(
      finalState.steps.branchA?.attempts,
      'branchA attempts must stay at 1 — the step was not re-run',
    ).toBe(1);

    // branchB must have been retried — attempts incremented to 2.
    expect(
      finalState.steps.branchB?.attempts,
      'branchB attempts must be 2 after the resume attempt',
    ).toBe(2);

    expect(finalState.steps.branchB?.status).toBe('succeeded');
    expect(finalState.steps.end?.status).toBe('succeeded');
    expect(finalState.steps.entry?.status).toBe('succeeded');
    expect(finalState.steps.branchA?.status).toBe('succeeded');
  });
});
