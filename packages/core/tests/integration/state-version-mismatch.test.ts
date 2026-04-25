/**
 * TC-005: State version mismatch blocks resume.
 *
 * When state.json records flowVersion '0.1.0' but the flow module exports
 * version '0.2.0', orchestrator.resume() must throw StateVersionMismatchError
 * before invoking any provider.
 *
 * Failure path inside resume():
 *   1. loadState() reads state.json — succeeds.
 *   2. loadFlowRef() reads flow-ref.json — succeeds.
 *   3. flow-ref.json matches state.json (both record my-flow@0.1.0), so the
 *      first consistency check passes.
 *   4. importFlow() loads the fixture which exports my-flow@0.2.0.
 *   5. verifyCompatibility(state, { flowName: 'my-flow', flowVersion: '0.2.0' })
 *      detects the mismatch and returns err(StateVersionMismatchError).
 *   6. resume() throws the error — no provider authenticate() or invoke()
 *      calls occur.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineError } from '../../src/errors.js';
import { ERROR_CODES, StateVersionMismatchError } from '../../src/errors.js';
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
 * Provider that records each invoke() call. Any call to invoke() is an
 * assertion failure — resume must reject before the provider is reached.
 */
class TrackingProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  readonly invokedSteps: string[] = [];
  readonly authenticateCalled: boolean[] = [];

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    this.authenticateCalled.push(true);
    return ok({ ok: true, billingSource: 'local', detail: 'tracking mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokedSteps.push(ctx.stepId);
    throw new Error(`invoke must not be called — got stepId "${ctx.stepId}"`);
  }

  stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    this.invokedSteps.push(ctx.stepId);
    throw new Error(`stream must not be called — got stepId "${ctx.stepId}"`);
  }
}

// ── helper: write the boilerplate files a resumed run expects ─────────────────

/**
 * Write flow-ref.json and metrics.json stubs so resume() can locate the flow
 * and load cost data without ENOENT.
 *
 * IMPORTANT: flowVersion in flow-ref.json must match state.json ('0.1.0') so
 * the first consistency check inside resume() passes. The version mismatch
 * surfaces when importFlow() loads the fixture and verifyCompatibility
 * compares the loaded flow version ('0.2.0') against the persisted state.
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

describe('TC-005: state version mismatch blocks resume', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-vsn-mismatch-'));
    await writeFile(join(FIXTURES_DIR, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('throws StateVersionMismatchError when state is 0.1.0 but flow is 0.2.0', {
    timeout: 15_000,
  }, async () => {
    // The flow-ref.json records the same version as state.json ('0.1.0') so
    // the first consistency check inside resume() passes. The fixture flow
    // module exports version '0.2.0', so verifyCompatibility detects the
    // mismatch and returns err(StateVersionMismatchError).
    const flowPath = join(FIXTURES_DIR, 'my-flow-v0.2.0.ts');
    const stateFlowName = 'my-flow';
    const stateFlowVersion = '0.1.0';

    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-vsn-mismatch',
      flowName: stateFlowName,
      flowVersion: stateFlowVersion,
      status: 'failed',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        'step-a': {
          status: 'failed',
          attempts: 1,
          startedAt: now,
          completedAt: now,
        },
      },
    };

    await writeRunBoilerplate(runDir, stateFlowName, stateFlowVersion, flowPath);
    await atomicWriteJson(join(runDir, 'state.json'), injectedState);

    const trackingProvider = new TrackingProvider();
    const registry = new ProviderRegistry();
    registry.register(trackingProvider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir,
    });

    // resume() must throw StateVersionMismatchError before any step runs.
    await expect(
      orchestrator.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: FIXTURES_DIR,
        flagProvider: 'mock',
        worktree: false,
      }),
    ).rejects.toThrow(StateVersionMismatchError);
  });

  it('thrown error has code relay_STATE_VERSION_MISMATCH', {
    timeout: 15_000,
  }, async () => {
    const flowPath = join(FIXTURES_DIR, 'my-flow-v0.2.0.ts');
    const stateFlowName = 'my-flow';
    const stateFlowVersion = '0.1.0';

    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-vsn-mismatch-code',
      flowName: stateFlowName,
      flowVersion: stateFlowVersion,
      status: 'failed',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        'step-a': {
          status: 'failed',
          attempts: 1,
          startedAt: now,
          completedAt: now,
        },
      },
    };

    await writeRunBoilerplate(runDir, stateFlowName, stateFlowVersion, flowPath);
    await atomicWriteJson(join(runDir, 'state.json'), injectedState);

    const trackingProvider = new TrackingProvider();
    const registry = new ProviderRegistry();
    registry.register(trackingProvider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir,
    });

    let caughtError: unknown;
    try {
      await orchestrator.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: FIXTURES_DIR,
        flagProvider: 'mock',
        worktree: false,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(StateVersionMismatchError);
    const e = caughtError as StateVersionMismatchError;
    expect(e.code).toBe(ERROR_CODES.STATE_VERSION_MISMATCH);
    expect(e.code).toBe('relay_STATE_VERSION_MISMATCH');
  });

  it('no provider invoke calls occur when version mismatch is detected', {
    timeout: 15_000,
  }, async () => {
    const flowPath = join(FIXTURES_DIR, 'my-flow-v0.2.0.ts');
    const stateFlowName = 'my-flow';
    const stateFlowVersion = '0.1.0';

    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-vsn-mismatch-no-invoke',
      flowName: stateFlowName,
      flowVersion: stateFlowVersion,
      status: 'failed',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        'step-a': {
          status: 'failed',
          attempts: 1,
          startedAt: now,
          completedAt: now,
        },
      },
    };

    await writeRunBoilerplate(runDir, stateFlowName, stateFlowVersion, flowPath);
    await atomicWriteJson(join(runDir, 'state.json'), injectedState);

    const trackingProvider = new TrackingProvider();
    const registry = new ProviderRegistry();
    registry.register(trackingProvider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir,
    });

    await expect(
      orchestrator.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: FIXTURES_DIR,
        flagProvider: 'mock',
        worktree: false,
      }),
    ).rejects.toBeInstanceOf(StateVersionMismatchError);

    // The version check fires before provider authentication or any step
    // dispatch, so invoke must never have been called.
    expect(
      trackingProvider.invokedSteps,
      'provider.invoke must not be called when version mismatch is detected',
    ).toHaveLength(0);
  });
});
