/**
 * Real-Claude end-to-end smoke test — audit recommendation #3.
 *
 * RUN MANUALLY on a dev machine with a Max subscription:
 *   RELAY_SMOKE_REAL=1 pnpm -F @relay/cli test packages/cli/tests/smoke/real-claude.smoke.test.ts
 *
 * NEVER run in CI until Anthropic provides CI-safe credentials.
 *
 * Preconditions:
 *   - claude binary on PATH
 *   - CLAUDE_CODE_OAUTH_TOKEN set (subscription billing)
 *   - ANTHROPIC_API_KEY must NOT be set for test 1 (billing-safety guard)
 *
 * Before running, build the fixture flow:
 *   cd packages/cli/tests/smoke/fixtures/mini-flow
 *   npx tsc --outDir dist --module NodeNext --moduleResolution NodeNext \
 *     --target ES2022 --strict --skipLibCheck flow.ts
 *
 * The fixture imports from @relay/core. If tsc cannot resolve it, run
 * `pnpm install` from the workspace root first so node_modules is populated.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Environment gate — every test in this file skips unless RELAY_SMOKE_REAL=1.
// ---------------------------------------------------------------------------

const SMOKE = Boolean(process.env['RELAY_SMOKE_REAL']);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = dirname(THIS_FILE);

/** Absolute path to the mini-flow fixture directory. */
const FIXTURE_DIR = resolve(THIS_DIR, 'fixtures/mini-flow');

/**
 * Absolute path to the relay bin shim.
 *
 * bin/relay.js does `import('../dist/cli.js')` — it requires the CLI package
 * to be built. Run `pnpm -F @relay/cli build` before running this test.
 */
const RELAY_BIN = resolve(THIS_DIR, '../../../../bin/relay.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the 6-hex run ID from the CLI stdout.
 *
 * The start banner emits a `run` kvLine:
 *   run     <runId>  ·  YYYY-MM-DD HH:mmZ
 *
 * Match the first 6-char hex token on a line that starts with "run ".
 */
function extractRunId(stdout: string): string | null {
  const match = /^run\s+([a-f0-9]{6})\b/m.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * Build the runDir for a given runId.
 * Relay writes state under <cwd>/.relay/runs/<runId>/.
 * The child process's cwd is the workspace root (process.cwd() from the test runner).
 */
function runDirFor(runId: string): string {
  return join(process.cwd(), '.relay', 'runs', runId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay run (real Claude)', () => {
  /**
   * Primary smoke test — run the two-step mini-flow to completion.
   *
   * Asserts:
   *   1. Exit code 0.
   *   2. state.json final status is 'succeeded'.
   *   3. Banner contains the word "subscription" (billing mode is subscription).
   *   4. No `api-account` token appears in run.log (SDK env allowlist is working).
   *   5. ANTHROPIC_API_KEY is absent from the child environment.
   */
  it.skipIf(!SMOKE)('runs a two-step flow to completion', () => {
    // Strip ANTHROPIC_API_KEY from the child env so the billing-safety guard
    // does not fire on the developer's shell if they happen to have it set.
    const childEnv = { ...process.env };
    // Explicitly delete the key — passing `undefined` in a spread does NOT
    // remove the key on all Node versions; we must use delete.
    delete childEnv['ANTHROPIC_API_KEY'];

    const result = spawnSync(
      process.execPath,
      [RELAY_BIN, 'run', FIXTURE_DIR, 'target=world'],
      {
        encoding: 'utf8',
        timeout: 120_000,
        env: childEnv,
        // Run from the workspace root so .relay/runs/ lands in a predictable spot.
        cwd: process.cwd(),
      },
    );

    // --- 1. exit code ---
    expect(
      result.status,
      `relay run exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);

    // --- 2. state.json status ---
    const runId = extractRunId(result.stdout);
    expect(runId, 'could not find run ID in stdout').not.toBeNull();

    const runDir = runDirFor(runId!);
    const stateJsonPath = join(runDir, 'state.json');
    expect(existsSync(stateJsonPath), `state.json not found at ${stateJsonPath}`).toBe(true);

    const stateJson = JSON.parse(readFileSync(stateJsonPath, 'utf8')) as {
      status: string;
    };
    expect(stateJson.status).toBe('succeeded');

    // --- 3. subscription billing mode in banner ---
    // The start banner emits: "bill     subscription (max)  ·  no api charges"
    // Match on the word "subscription" since chalk may colorize the text and
    // colors are disabled when stdout is not a TTY (which it isn't in spawnSync).
    expect(result.stdout).toContain('subscription');

    // --- 4. run.log does not mention api-account billing ---
    // The auth guard emits billingSource: 'api-account' in the ClaudeAuthError
    // if ANTHROPIC_API_KEY bypassed the check. Verify the log is clean.
    const runLogPath = join(runDir, 'run.log');
    if (existsSync(runLogPath)) {
      const runLog = readFileSync(runLogPath, 'utf8');
      expect(runLog).not.toContain('api-account');
    }

    // --- 5. ANTHROPIC_API_KEY was absent from child env ---
    // The env we passed to spawnSync had the key deleted. This assertion is a
    // belt-and-suspenders check that we did not accidentally re-inject it.
    expect(childEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  /**
   * Billing-safety guard smoke test.
   *
   * Asserts that when ANTHROPIC_API_KEY is present in the environment (and no
   * --api-key flag is passed), relay run exits with code 3 and the stderr
   * mentions ANTHROPIC_API_KEY. This validates the §8.1 guard fires end-to-end
   * through the real binary, not just through unit tests of auth.ts.
   */
  it.skipIf(!SMOKE)('billing-safety: ANTHROPIC_API_KEY blocked without --api-key', () => {
    const result = spawnSync(
      process.execPath,
      [RELAY_BIN, 'run', FIXTURE_DIR, 'target=world'],
      {
        encoding: 'utf8',
        // Short timeout — the guard fires before any SDK call.
        timeout: 10_000,
        env: {
          ...process.env,
          // Inject a fake API key. The guard must reject it regardless of value.
          ANTHROPIC_API_KEY: 'sk-ant-test-key-that-is-fake',
          // Ensure RELAY_ALLOW_API_KEY is NOT set so the guard fires.
          RELAY_ALLOW_API_KEY: undefined,
        },
        cwd: process.cwd(),
      },
    );

    // Exit code 3 is ClaudeAuthError (see packages/cli/src/exit-codes.ts).
    expect(
      result.status,
      `expected exit 3 (ClaudeAuthError) but got ${result.status}.\nstderr:\n${result.stderr}`,
    ).toBe(3);

    // The formatted error (formatError) includes "ANTHROPIC_API_KEY" in the
    // refusal message. Confirmed from packages/cli/src/exit-codes.ts:
    //   "✕ Refusing to run: ANTHROPIC_API_KEY would override your subscription"
    expect(result.stderr).toContain('ANTHROPIC_API_KEY');
  });

  /**
   * Resume-status-gate smoke test — FLAG-13 policy (task_101, Core Hardening sprint).
   *
   * When task_101 lands, remove `|| true` from skipIf and implement the body:
   *   1. Run relay run once (succeeds, captures runId from stdout).
   *   2. Run relay run again pointing at the SAME runDir (--resume <runId>).
   *   3. Assert the elapsed wall-clock time of the second invocation is < 1000ms
   *      (the resume-status-gate short-circuits before invoking any provider).
   *   4. Assert state.json status is still 'succeeded' (no re-run occurred).
   *
   * The short-circuit behaviour is defined in task_101: if a run's state.json
   * already has status === 'succeeded' or 'failed', the runner returns the
   * cached result without re-executing any step.
   */
  it.skipIf(!SMOKE || true)(
    'TODO(task_101): second invocation short-circuits via resume-status-gate',
    () => {
      // Step 1 — first run (identical to the primary smoke test above).
      const childEnv = { ...process.env };
      delete childEnv['ANTHROPIC_API_KEY'];

      const firstRun = spawnSync(
        process.execPath,
        [RELAY_BIN, 'run', FIXTURE_DIR, 'target=world'],
        { encoding: 'utf8', timeout: 120_000, env: childEnv, cwd: process.cwd() },
      );
      expect(firstRun.status).toBe(0);

      const runId = extractRunId(firstRun.stdout);
      expect(runId).not.toBeNull();

      // Step 2 — second run using --resume on the same runDir.
      const t0 = Date.now();
      const secondRun = spawnSync(
        process.execPath,
        [RELAY_BIN, 'run', FIXTURE_DIR, 'target=world', '--resume', runId!],
        { encoding: 'utf8', timeout: 10_000, env: childEnv, cwd: process.cwd() },
      );
      const elapsed = Date.now() - t0;

      // Step 3 — must return in < 1s (no provider calls).
      expect(
        elapsed,
        `second invocation took ${elapsed}ms — expected <1000ms (cache hit)`,
      ).toBeLessThan(1000);

      // Step 4 — status must still be 'succeeded'.
      expect(secondRun.status).toBe(0);
      const stateJson = JSON.parse(
        readFileSync(join(runDirFor(runId!), 'state.json'), 'utf8'),
      ) as { status: string };
      expect(stateJson.status).toBe('succeeded');
    },
  );
});
