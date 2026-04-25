/**
 * TC-001: Crash resume preserves attempt counter across SIGKILL.
 *
 * Uses state injection (seeding state.json directly) rather than fork+SIGKILL.
 * Seeds step-A as succeeded (attempts:1) and step-B as running (attempts:1) —
 * simulating the on-disk state left by a SIGKILL that hit while step-B was
 * executing. Calls resume() and asserts that:
 *
 *   1. The zombie sweep transitions step-B from 'running' to 'failed'.
 *   2. The reset pass transitions step-B from 'failed' to 'pending', preserving
 *      the attempts counter.
 *   3. stateMachine.startStep() increments attempts to 2 before dispatch.
 *   4. The final persisted state shows step-B with attempts:2 and status:'succeeded'.
 *   5. The provider is invoked exactly once (step-B only — step-A is not re-run).
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
 * Provider that records which steps it was asked to invoke and succeeds on
 * every call. Used to assert step-A is never re-invoked on resume and
 * step-B is invoked exactly once.
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

/**
 * Write the boilerplate files resume() expects to find in runDir:
 *   - flow-ref.json  (so resume can re-import the flow)
 *   - metrics.json   (so CostTracker.load() does not throw ENOENT)
 *   - live/          (created by run() but not re-created by resume())
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
  await atomicWriteJson(join(runDir, 'metrics.json'), []);
  await mkdir(join(runDir, 'live'), { recursive: true });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('crash-resume: attempt counter preservation (TC-001)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-crash-attempts-'));
    // The fixture flow references 'p.md' as its prompt file. Ensure the file
    // exists so executePrompt does not hit ENOENT during resume.
    await writeFile(join(FIXTURES_DIR, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('resume increments step-B attempts to 2 after SIGKILL with attempts:1 on disk', {
    timeout: 20_000,
  }, async () => {
    // The crash-test-flow fixture defines a two-step linear flow:
    //   step 'a' (root) -> step 'b' (dependsOn: ['a'])
    const flowPath = join(FIXTURES_DIR, 'crash-test-flow.ts');
    const flowName = 'crash-test-flow';
    const flowVersion = '0.1.0';

    // ── Inject the mid-run state ───────────────────────────────────────────
    //
    // This mirrors what state.json looks like after a SIGKILL while step-B
    // is in flight:
    //   - step 'a': succeeded (attempts:1) — completed before the crash
    //   - step 'b': running  (attempts:1) — was executing when killed
    //
    // SIGKILL bypasses markRun() and completeStep(), so step-B is left in
    // 'running' status on disk with no completedAt. The resume path must:
    //   1. zombie-sweep 'running' -> 'failed' (preserving attempts:1)
    //   2. reset         'failed'  -> 'pending' (preserving attempts:1)
    //   3. startStep     'pending' -> 'running', increments attempts to 2
    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-crash-attempts-01',
      flowName,
      flowVersion,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        a: {
          status: 'succeeded',
          attempts: 1,
          startedAt: now,
          completedAt: now,
          handoffs: ['a-out'],
        },
        b: {
          // 'running' with no completedAt — simulates the SIGKILL snapshot.
          status: 'running',
          attempts: 1,
          startedAt: now,
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

    // step-B must have been invoked exactly once — the single retry after
    // the crash. step-A must never be re-invoked (it already succeeded).
    expect(
      trackingProvider.invokedSteps,
      'step-B must be invoked on resume — it was a zombie',
    ).toContain('b');

    expect(
      trackingProvider.invokedSteps,
      'step-A must not be re-invoked — it already succeeded before the crash',
    ).not.toContain('a');

    const invocationsOfB = trackingProvider.invokedSteps.filter((id) => id === 'b');
    expect(invocationsOfB.length, 'provider must be called exactly once for step-B').toBe(1);

    // Read back the final persisted state and assert the attempt counter.
    const finalStateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
    const finalState = JSON.parse(finalStateRaw) as RunState;

    expect(finalState.status).toBe('succeeded');

    // step-A is unchanged — still succeeded with attempts:1.
    expect(finalState.steps.a?.status).toBe('succeeded');
    expect(
      finalState.steps.a?.attempts,
      'step-A attempts must remain 1 — it was not re-dispatched',
    ).toBe(1);

    // step-B must show attempts:2 — the counter carried forward from the
    // crashed run (attempts:1) and startStep incremented it before dispatch.
    expect(finalState.steps.b?.status).toBe('succeeded');
    expect(
      finalState.steps.b?.attempts,
      'step-B attempts must be 2 — prior attempt (1) preserved across resume, then incremented by startStep',
    ).toBe(2);
  });
});
