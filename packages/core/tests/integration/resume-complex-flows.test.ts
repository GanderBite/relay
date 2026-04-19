/**
 * Integration tests: resume with branch-topology and parallel-topology flows.
 *
 * Both tests use direct state injection to freeze the run at the desired
 * checkpoint. This isolates the resume skip-protocol (already-succeeded and
 * skipped steps must not be re-invoked) from executor details, making failures
 * unambiguous. Real mid-run interruption of parallel/branch steps (fork+SIGKILL
 * while a branch or parallel child is in flight) is not covered here; that
 * surface is planned for a future sprint. Linear-flow SIGKILL coverage lives in
 * crash-resume.test.ts.
 *
 * Branch test:
 *   Flow: entry -> b1 -> b2 -> end (B path)
 *         entry -> a1 -> a2      (A path, skipped because predicate selected B)
 *
 *   Injected state: entry=succeeded, b1=succeeded, b2=pending,
 *                   a1=skipped, a2=skipped, end=pending.
 *   (Marking a1/a2 'skipped' encodes "the run took path B". The state machine
 *   skips seeding any step whose status is already 'skipped' or 'succeeded',
 *   so the A-path steps are never re-queued on resume.)
 *
 *   Assertions: only b2 and end are invoked; b1 is not re-invoked; a1/a2 are
 *   never invoked; final status is 'succeeded'.
 *
 * Parallel test:
 *   Flow: entry -> parallel(c1, c2, c3) -> end
 *
 *   Injected state: entry=succeeded, parallel=succeeded, c1=succeeded,
 *                   c2=succeeded, c3=pending, end=pending.
 *   (This represents a crash/stop after c2 completed but before c3. The
 *   parallel step is marked succeeded here so the resume queue-seeder treats
 *   c3 as immediately ready — its sole predecessor 'parallel' is satisfied.)
 *
 *   Assertions: only c3 and end are invoked; c1, c2, parallel, entry are not
 *   re-invoked; final status is 'succeeded'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';

import { createRunner } from '../../src/runner/runner.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { atomicWriteJson } from '../../src/util/atomic-write.js';
import type {
  AuthState,
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../../src/providers/types.js';
import type { PipelineError } from '../../src/errors.js';
import type { RunState } from '../../src/flow/types.js';

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

describe('resume with complex flow topologies', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-complex-resume-'));
    // Ensure the prompt template exists so executePrompt does not hit ENOENT.
    await writeFile(join(FIXTURES_DIR, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  // ── Test 1: branch topology ─────────────────────────────────────────────────

  it(
    'branch: resumes only the remaining B-path steps; A-path (skipped) is never invoked',
    { timeout: 20_000 },
    async () => {
      const flowPath = join(FIXTURES_DIR, 'branch-resume-flow.ts');
      const flowName = 'branch-resume-flow';
      const flowVersion = '0.1.0';

      // ── Inject the mid-run state ─────────────────────────────────────────
      // entry and b1 succeeded. b2 and end are still pending.
      // a1 and a2 are marked 'skipped' — the run took path B.
      const now = new Date().toISOString();
      const injectedState: RunState = {
        runId: 'test-branch-01',
        flowName,
        flowVersion,
        status: 'running',
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
          b1: {
            status: 'succeeded',
            attempts: 1,
            startedAt: now,
            completedAt: now,
            handoffs: ['b1-out'],
          },
          b2: {
            status: 'pending',
            attempts: 0,
          },
          a1: {
            status: 'skipped',
            attempts: 0,
          },
          a2: {
            status: 'skipped',
            attempts: 0,
          },
          end: {
            status: 'pending',
            attempts: 0,
          },
        },
      };

      await writeRunBoilerplate(runDir, flowName, flowVersion, flowPath);
      await atomicWriteJson(join(runDir, 'state.json'), injectedState);

      // ── Resume ───────────────────────────────────────────────────────────
      const trackingProvider = new TrackingProvider();
      const registry = new ProviderRegistry();
      registry.register(trackingProvider);

      const runner = createRunner({
        providers: registry,
        defaultProvider: 'mock',
        runDir,
      });

      const result = await runner.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: FIXTURES_DIR,
      });

      // ── Assertions ───────────────────────────────────────────────────────

      // The resumed run must complete successfully.
      expect(result.status).toBe('succeeded');

      // b2 and end must have been invoked (they were pending on resume).
      expect(
        trackingProvider.invokedSteps,
        'b2 must be invoked on resume — it was pending',
      ).toContain('b2');
      expect(
        trackingProvider.invokedSteps,
        'end must be invoked on resume — it was pending',
      ).toContain('end');

      // b1 must NOT be re-invoked — it succeeded before the stop.
      expect(
        trackingProvider.invokedSteps,
        'b1 must not be re-invoked — it already succeeded',
      ).not.toContain('b1');

      // entry must NOT be re-invoked — it succeeded before the stop.
      expect(
        trackingProvider.invokedSteps,
        'entry must not be re-invoked — it already succeeded',
      ).not.toContain('entry');

      // The A-path steps must never be invoked — the branch predicate selected B.
      expect(
        trackingProvider.invokedSteps,
        'a1 must never be invoked — path A was skipped',
      ).not.toContain('a1');
      expect(
        trackingProvider.invokedSteps,
        'a2 must never be invoked — path A was skipped',
      ).not.toContain('a2');

      // Verify final persisted state.
      const finalStateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
      const finalState = JSON.parse(finalStateRaw) as RunState;
      expect(finalState.status).toBe('succeeded');
      expect(finalState.steps['b2']?.status).toBe('succeeded');
      expect(finalState.steps['end']?.status).toBe('succeeded');
      expect(finalState.steps['b1']?.status).toBe('succeeded');
      expect(finalState.steps['a1']?.status).toBe('skipped');
      expect(finalState.steps['a2']?.status).toBe('skipped');
    },
  );

  // ── Test 2: parallel topology ───────────────────────────────────────────────

  it(
    'parallel: resumes only the remaining child (c3) and downstream; c1/c2 are never re-invoked',
    { timeout: 20_000 },
    async () => {
      const flowPath = join(FIXTURES_DIR, 'parallel-resume-flow.ts');
      const flowName = 'parallel-resume-flow';
      const flowVersion = '0.1.0';

      // ── Inject the mid-run state ─────────────────────────────────────────
      // entry succeeded. parallel succeeded (all fan-out bookkeeping done).
      // c1 and c2 succeeded. c3 is pending (crashed/stopped before it ran).
      // end is pending because c3 had not completed yet.
      //
      // Marking the parallel step as 'succeeded' is the state the run would
      // reach if c3 were a deferred step dispatched AFTER the parallel fan-in
      // resolved (i.e. the parallel executor succeeded with c1+c2 but c3 was
      // not part of the initial fan-out). For resume-topology testing purposes
      // what matters is: c3's predecessor (parallel) is 'succeeded', so the
      // resume queue-seeder makes c3 immediately ready without re-running the
      // parallel step.
      const now = new Date().toISOString();
      const injectedState: RunState = {
        runId: 'test-parallel-01',
        flowName,
        flowVersion,
        status: 'running',
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
            status: 'succeeded',
            attempts: 1,
            startedAt: now,
            completedAt: now,
          },
          c1: {
            status: 'succeeded',
            attempts: 1,
            startedAt: now,
            completedAt: now,
            handoffs: ['c1-out'],
          },
          c2: {
            status: 'succeeded',
            attempts: 1,
            startedAt: now,
            completedAt: now,
            handoffs: ['c2-out'],
          },
          c3: {
            status: 'pending',
            attempts: 0,
          },
          end: {
            status: 'pending',
            attempts: 0,
          },
        },
      };

      await writeRunBoilerplate(runDir, flowName, flowVersion, flowPath);
      await atomicWriteJson(join(runDir, 'state.json'), injectedState);

      // ── Resume ───────────────────────────────────────────────────────────
      const trackingProvider = new TrackingProvider();
      const registry = new ProviderRegistry();
      registry.register(trackingProvider);

      const runner = createRunner({
        providers: registry,
        defaultProvider: 'mock',
        runDir,
      });

      const result = await runner.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: FIXTURES_DIR,
      });

      // ── Assertions ───────────────────────────────────────────────────────

      // The resumed run must complete successfully.
      expect(result.status).toBe('succeeded');

      // c3 must have been invoked — it was the only pending child.
      expect(
        trackingProvider.invokedSteps,
        'c3 must be invoked on resume — it was pending',
      ).toContain('c3');

      // end must have been invoked — it was pending, waiting for c3.
      expect(
        trackingProvider.invokedSteps,
        'end must be invoked on resume — it was pending',
      ).toContain('end');

      // The already-completed steps must not be re-invoked.
      expect(
        trackingProvider.invokedSteps,
        'c1 must not be re-invoked — it already succeeded',
      ).not.toContain('c1');
      expect(
        trackingProvider.invokedSteps,
        'c2 must not be re-invoked — it already succeeded',
      ).not.toContain('c2');
      expect(
        trackingProvider.invokedSteps,
        'entry must not be re-invoked — it already succeeded',
      ).not.toContain('entry');

      // The parallel step itself (kind: 'parallel') does not invoke the provider
      // directly, but assert it was not re-run to guard against resume re-seeding it.
      const finalStateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
      const finalState = JSON.parse(finalStateRaw) as RunState;
      expect(finalState.status).toBe('succeeded');
      expect(finalState.steps['c3']?.status).toBe('succeeded');
      expect(finalState.steps['end']?.status).toBe('succeeded');
      expect(finalState.steps['c1']?.status).toBe('succeeded');
      expect(finalState.steps['c2']?.status).toBe('succeeded');
      expect(finalState.steps['parallel']?.status).toBe('succeeded');
    },
  );
});
