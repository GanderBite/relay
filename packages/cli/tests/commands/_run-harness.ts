/**
 * Shared test harness for run-integration tests.
 *
 * This file centralises the six vi.mock(...) factory calls that the
 * run-integration test suite requires.  Importing this file causes vitest to
 * register the mocks as a side-effect (vitest hoists vi.mock calls from every
 * file in the module graph of a test entry-point).
 *
 * WrappedOrchestrator behaviour (run mode):
 *   Every new Orchestrator instance overrides both runDir and providers from
 *   the shared refs, regardless of what the caller passed in opts.  This lets
 *   runCommand (which constructs its own Orchestrator internally) use the
 *   per-test registry and temp directory without any production-code changes.
 *
 * Exported refs and stubs are written to by beforeEach in each test file.
 * Plain mutable objects are used instead of vi.hoisted() because vi.hoisted()
 * cannot be exported from helper modules (vitest 4.x constraint).  The module
 * is fully evaluated before the mock factory closures run, so the refs are
 * already initialised when the factories close over them.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable refs — plain objects, mutated by beforeEach in the test file.
// ---------------------------------------------------------------------------

export const runDirRef: { current: string } = { current: '' };
export const registryRef: { current: unknown } = { current: null };

// ---------------------------------------------------------------------------
// Controllable CLI-layer stubs
// ---------------------------------------------------------------------------

export const mockLoadFlow = vi.fn();
export const mockParseInputFromArgv = vi.fn();
export const mockRenderStartBanner = vi.fn(() => '');
export const mockRenderSuccessBanner = vi.fn(() => '');
export const mockRegisterDefaultProviders = vi.fn();
export const mockLoadGlobalSettings = vi.fn();
export const mockLoadFlowSettings = vi.fn();
export const mockResolveProvider = vi.fn();

// ---------------------------------------------------------------------------
// @ganderbite/relay-core — WrappedOrchestrator (run mode: always-override)
// ---------------------------------------------------------------------------

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  // Replace the Orchestrator class so every instance:
  //   1. uses the test-supplied runDir (so artefacts land in the temp dir), and
  //   2. uses the test-supplied ProviderRegistry (so each test controls the provider).
  const WrappedOrchestrator = class extends actual.Orchestrator {
    constructor(opts?: ConstructorParameters<typeof actual.Orchestrator>[0]) {
      super({
        ...(opts ?? {}),
        runDir: runDirRef.current,
        providers: registryRef.current as InstanceType<typeof actual.ProviderRegistry>,
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
// CLI-layer module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
}));

vi.mock('../../src/input-parser.js', () => ({
  parseInputFromArgv: (...args: unknown[]) => mockParseInputFromArgv(...args),
  normalizeArgvInput: (_argv: string[]) => ({ inputPrimary: '.', inputExtras: [] }),
}));

vi.mock('../../src/banner.js', () => ({
  renderStartBanner: (...args: unknown[]) => mockRenderStartBanner(...args),
  renderSuccessBanner: (...args: unknown[]) => mockRenderSuccessBanner(...args),
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
  maybeSendRunEvent: vi.fn(),
}));
