/**
 * Shared mock harness for CLI end-to-end integration tests.
 *
 * Key distinction from tests/commands/_run-harness.ts and
 * tests/commands/_resume-harness.ts: this harness does NOT mock
 * `../../src/flow-loader.js`. Tests that import this harness exercise the
 * real loadFlow() path, which means a genuine dynamic import of the fixture
 * flow module and the real duck-type validation. This catches CLI/core API
 * drift that the unit-level harnesses mask.
 *
 * What IS mocked:
 *   - @ganderbite/relay-core's Orchestrator — wraps it to inject the
 *     per-test ProviderRegistry and (in run mode) the per-test runDir.
 *   - registerDefaultProviders, loadGlobalSettings, loadFlowSettings,
 *     resolveProvider — replaced with controllable stubs so tests never
 *     touch global settings files or the ClaudeCliProvider.
 *   - Banner, progress, paused-banner, telemetry — output suppressed.
 *
 * Exported refs are mutated by beforeEach in each test file. Plain mutable
 * objects are used because vi.hoisted() cannot be exported from helper modules
 * (vitest 4.x constraint).
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable refs — mutated by beforeEach in each test file.
// ---------------------------------------------------------------------------

/** The runDir that the WrappedOrchestrator (run mode) will use. */
export const runDirRef: { current: string } = { current: '' };

/** The ProviderRegistry instance that the WrappedOrchestrator injects. */
export const registryRef: { current: unknown } = { current: null };

// ---------------------------------------------------------------------------
// Controllable stubs
// ---------------------------------------------------------------------------

export const mockRegisterDefaultProviders = vi.fn();
export const mockLoadGlobalSettings = vi.fn();
export const mockLoadFlowSettings = vi.fn();
export const mockResolveProvider = vi.fn();

// ---------------------------------------------------------------------------
// @ganderbite/relay-core — WrappedOrchestrator
//
// Run mode: always override both runDir and providers from the shared refs
// regardless of what the CLI passed to the constructor.
//
// Resume mode (test sets opts.providers explicitly via createOrchestrator):
// preserve an explicit providers option; inject registryRef when absent.
// runDir is NOT overridden in resume mode — resumeCommand derives it from
// the runId argument.
// ---------------------------------------------------------------------------

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();

  const WrappedOrchestrator = class extends actual.Orchestrator {
    constructor(opts?: ConstructorParameters<typeof actual.Orchestrator>[0]) {
      // Preserve an explicit providers option (test-side createOrchestrator
      // calls for the resume phase-1 run). Inject registryRef only when the
      // CLI creates a bare `new Orchestrator({ runDir })` without providers.
      const explicitProviders = (opts as { providers?: unknown } | undefined)?.providers;
      const effectiveProviders =
        explicitProviders !== undefined
          ? explicitProviders
          : (registryRef.current as InstanceType<typeof actual.ProviderRegistry>);

      // Run mode: override runDir from the shared ref so CLI-created run
      // dirs land in the temp dir. Resume mode: keep the runDir the caller
      // supplied (or derived from runId) — the ref value is irrelevant there.
      const effectiveRunDir =
        runDirRef.current !== ''
          ? runDirRef.current
          : (opts as { runDir?: string } | undefined)?.runDir;

      super({
        ...(opts ?? {}),
        ...(effectiveRunDir !== undefined ? { runDir: effectiveRunDir } : {}),
        providers: effectiveProviders as InstanceType<typeof actual.ProviderRegistry>,
      });
    }
  };

  return {
    ...actual,
    Orchestrator: WrappedOrchestrator,
    registerDefaultProviders: () => mockRegisterDefaultProviders(),
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    loadFlowSettings: (_dir: string) => mockLoadFlowSettings(_dir),
    resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
  };
});

// ---------------------------------------------------------------------------
// CLI-layer output mocks — suppress all terminal output
// ---------------------------------------------------------------------------

vi.mock('../../src/banner.js', () => ({
  renderStartBanner: vi.fn(() => ''),
  renderSuccessBanner: vi.fn(() => ''),
  renderFailureBanner: vi.fn(() => ''),
}));

vi.mock('../../src/paused-banner.js', () => ({
  renderPausedBanner: vi.fn(),
}));

vi.mock('../../src/progress.js', () => ({
  ProgressDisplay: class MockProgress {
    start = vi.fn();
    stop = vi.fn();
    updateRunnerMetrics = vi.fn();
  },
}));

vi.mock('../../src/telemetry.js', () => ({
  maybySendRunEvent: vi.fn(),
  maybeSendRunEvent: vi.fn(),
}));
