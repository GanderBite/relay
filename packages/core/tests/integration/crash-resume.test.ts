/**
 * End-to-end crash-recovery integration test.
 *
 * Spawns Runner.run() in a child process (via child_process.fork). After step
 * "a" completes and step "b" starts streaming (signalled via IPC), the parent
 * sends SIGKILL to the child. The parent then calls Runner.resume(runDir) and
 * asserts:
 *
 *   (a) No step remains stuck in "running" status after resume — the zombie
 *       sweep (FLAG-12) converts orphaned "running" entries to "failed" before
 *       the failed→pending reset pass re-queues them.
 *   (b) Step "a" is not re-executed — succeeded steps are never re-invoked.
 *   (c) The final RunResult.status is "succeeded".
 *
 * The child process is a real OS process (fork + SIGKILL). No mocking of the
 * kill — this exercises the actual crash-recovery path end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';

import { createRunner } from '../../src/runner/runner.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
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

// Per-test timeouts are set via the options object passed as second argument
// to it(). The global testTimeout is 10s by default; the fork-based test
// needs more headroom for child startup and SIGKILL round-trip.

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(HERE, 'fixtures', 'child-runner.ts');

// ── helpers ──────────────────────────────────────────────────────────────────

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
 * Provider used during resume. Tracks which steps it was asked to invoke so
 * the test can assert that step "a" was not re-invoked. Step "a" should never
 * be called because it already succeeded before the crash.
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
 * Fork child-runner.ts with --experimental-strip-types. Returns a promise that
 * resolves once the child sends the 'live-state-observed' IPC message and the
 * child process is dead (after SIGKILL + exit wait). The promise rejects if
 * the child exits before sending the signal.
 */
function spawnAndKillAfterLiveState(runDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [runDir], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let signalReceived = false;
    let settled = false;

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err !== undefined) {
        reject(err);
      } else {
        resolve();
      }
    };

    child.on('message', (msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { type?: string }).type === 'live-state-observed' &&
        !signalReceived
      ) {
        signalReceived = true;
        // Real SIGKILL — bypasses markRun() so state.json is left with
        // status='running' and step "b" stuck in status='running'.
        child.kill('SIGKILL');
      }
    });

    child.on('exit', (code, signal) => {
      if (signalReceived) {
        // Expected path: child was killed after it signalled us.
        settle();
      } else {
        // Child exited before signalling — something went wrong.
        settle(
          new Error(
            `child-runner exited early without sending live-state-observed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      settle(err);
    });

    // Safety timeout: if the child never sends IPC, reject after 20s so the
    // test fails with a clear message rather than hanging until vitest times out.
    const safetyTimer = setTimeout(() => {
      if (!signalReceived) {
        child.kill('SIGKILL');
        settle(new Error('child-runner timed out waiting for live-state-observed IPC message'));
      }
    }, 20_000);

    child.on('exit', () => {
      clearTimeout(safetyTimer);
    });
  });
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('crash-resume integration (real SIGKILL)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-crash-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    'zombie sweep fires, succeeded step is not re-invoked, final status is succeeded',
    { timeout: 30_000 },
    async () => {
      // ── Phase 1: run child, SIGKILL after step "b" starts ─────────────────
      await spawnAndKillAfterLiveState(runDir);

      // ── Verify pre-resume state ────────────────────────────────────────────
      const rawState = await readFile(join(runDir, 'state.json'), 'utf8');
      const preResumeState = JSON.parse(rawState) as RunState;

      // After SIGKILL, state.json must still be present (written before step b
      // was invoked). The run-level status should be 'running' because markRun()
      // was never called — the SIGKILL bypassed the cleanup path.
      expect(preResumeState.status).toBe('running');
      // Step "a" succeeded before the kill.
      expect(preResumeState.steps['a']?.status).toBe('succeeded');
      // Step "b" was started (running) when the process was killed.
      expect(preResumeState.steps['b']?.status).toBe('running');

      // ── Phase 2: resume with a fresh TrackingProvider ──────────────────────
      const trackingProvider = new TrackingProvider();
      const registry = new ProviderRegistry();
      registry.register(trackingProvider);

      // The prompt executor reads promptFile from flowDir. The child wrote p.md
      // next to the fixture; pass flowDir so resume can find it.
      const fixtureDir = join(HERE, 'fixtures');
      await writeFile(join(fixtureDir, 'p.md'), 'ping', 'utf8');

      const runner = createRunner({
        providers: registry,
        runDir,
      });

      const result = await runner.resume(runDir, {
        authTimeoutMs: 5_000,
        flowDir: fixtureDir,
        flagProvider: 'mock',
      });

      // ── Assertions ─────────────────────────────────────────────────────────

      // (a) No zombie "running" step remains after resume.
      const finalStateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
      const finalState = JSON.parse(finalStateRaw) as RunState;
      for (const [stepId, stepState] of Object.entries(finalState.steps)) {
        expect(stepState.status, `step "${stepId}" must not be stuck in "running"`).not.toBe(
          'running',
        );
      }

      // (b) Step "a" succeeded before the crash and must not be re-executed.
      expect(
        trackingProvider.invokedSteps,
        'step "a" must not be re-invoked — it already succeeded before the crash',
      ).not.toContain('a');

      // Step "b" must have been re-executed by resume.
      expect(
        trackingProvider.invokedSteps,
        'step "b" must be re-invoked by resume — it was running when the crash happened',
      ).toContain('b');

      // (c) The resumed run completes successfully.
      expect(result.status).toBe('succeeded');

      // Sanity-check the final persisted state is also succeeded.
      expect(finalState.status).toBe('succeeded');
      expect(finalState.steps['a']?.status).toBe('succeeded');
      expect(finalState.steps['b']?.status).toBe('succeeded');
    },
  );
});
