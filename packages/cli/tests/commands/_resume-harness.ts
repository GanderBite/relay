/**
 * Shared test harness for resume-integration tests.
 *
 * This file centralises the six vi.mock(...) factory calls that the
 * resume-integration test suite requires.  Importing this file causes vitest
 * to register the mocks as a side-effect (vitest hoists vi.mock calls from
 * every file in the module graph of a test entry-point).
 *
 * WrappedOrchestrator behaviour (resume mode):
 *   When the caller passes an explicit providers option (i.e. the test itself
 *   calls createOrchestrator({ providers: explicitRegistry, ... })), that
 *   registry is preserved.  When the CLI creates a bare `new Orchestrator({
 *   runDir })` without providers, the constructor falls back to registryRef so
 *   the per-test MockProvider is injected automatically.  runDir is NOT
 *   overridden — resumeCommand derives it from the runId argument, and the
 *   test sets runDirRef to match what resumeCommand will construct.
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
export const mockRegisterDefaultProviders = vi.fn();
export const mockLoadGlobalSettings = vi.fn();
export const mockLoadFlowSettings = vi.fn();
export const mockResolveProvider = vi.fn();
export const mockResolveAndAuthenticate = vi.fn();

// ---------------------------------------------------------------------------
// @ganderbite/relay-core — WrappedOrchestrator (resume mode: preserve-explicit-providers)
// ---------------------------------------------------------------------------

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  // Wrap the Orchestrator so that when the CLI creates `new Orchestrator({
  // runDir })` (without a providers option), the constructor injects the
  // per-test registry from registryRef.  When the test itself calls
  // createOrchestrator({ providers: explicitRegistry, ... }), the explicit
  // providers take precedence (opts.providers !== undefined).
  const WrappedOrchestrator = class extends actual.Orchestrator {
    constructor(opts?: ConstructorParameters<typeof actual.Orchestrator>[0]) {
      const effectiveProviders =
        (opts as { providers?: unknown } | undefined)?.providers !== undefined
          ? (opts as { providers: unknown }).providers
          : (registryRef.current as InstanceType<typeof actual.ProviderRegistry>);
      super({
        ...(opts ?? {}),
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
    resolveAndAuthenticate: (...args: unknown[]) => mockResolveAndAuthenticate(...args),
  };
});

// ---------------------------------------------------------------------------
// CLI-layer module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
}));

vi.mock('../../src/input-parser.js', () => ({
  parseInputFromArgv: vi.fn(),
  normalizeArgvInput: (_argv: string[]) => ({ inputPrimary: '.', inputExtras: [] }),
}));

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
  maybeSendRunEvent: vi.fn(),
}));
