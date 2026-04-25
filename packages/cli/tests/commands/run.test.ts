/**
 * Tests for `relay run` command — flag parsing and option forwarding.
 *
 * Heavy I/O paths (flow loading, runner execution, provider auth) are mocked.
 * These tests verify that CLI flags parse correctly and are forwarded to the
 * Runner with the right shape. No live Claude calls, no real disk writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before the module-under-test loads.
// ---------------------------------------------------------------------------

const mockRunnerRun = vi.hoisted(() => vi.fn());
const mockLoadFlow = vi.hoisted(() => vi.fn());
const mockParseInputFromArgv = vi.hoisted(() => vi.fn());
const mockRegisterDefaultProviders = vi.hoisted(() => vi.fn());
const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockLoadFlowSettings = vi.hoisted(() => vi.fn());
const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockRenderStartBanner = vi.hoisted(() => vi.fn());
const mockRenderSuccessBanner = vi.hoisted(() => vi.fn());

vi.mock('@relay/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relay/core')>();
  return {
    ...actual,
    registerDefaultProviders: mockRegisterDefaultProviders,
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    loadFlowSettings: (_dir: string) => mockLoadFlowSettings(_dir),
    resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
    Orchestrator: class MockOrchestrator {
      run = mockRunnerRun;
    },
  };
});

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
}));

vi.mock('../../src/input-parser.js', () => ({
  parseInputFromArgv: (...args: unknown[]) => mockParseInputFromArgv(...args),
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
  },
}));

vi.mock('../../src/telemetry.js', () => ({
  maybySendRunEvent: vi.fn(),
  maybeSendRunEvent: vi.fn(),
}));

vi.mock('../../src/exit-codes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/exit-codes.js')>();
  return {
    ...actual,
    exitCodeFor: () => 1,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { err, NoProviderConfiguredError, ok } from '@relay/core';
import { renderFailureBanner } from '../../src/banner.js';
import runCommand from '../../src/commands/run.js';
import { renderPausedBanner } from '../../src/paused-banner.js';

/** Minimal race object that satisfies the run command's needs. */
function makeFlow() {
  return {
    name: 'test-flow',
    version: '0.1.0',
    input: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    stepOrder: ['step1'],
    steps: {},
    graph: { topoOrder: ['step1'], rootSteps: ['step1'], predecessors: new Map() },
  };
}

/** Minimal provider mock. */
function makeProvider() {
  return {
    name: 'claude-cli',
    capabilities: {},
    authenticate: vi
      .fn()
      .mockResolvedValue(
        ok({ ok: true, billingSource: 'subscription', detail: 'subscription (test)' }),
      ),
  };
}

/** Minimal RunResult. */
function makeRunResult(runId = 'abc123') {
  return {
    runId,
    runDir: `/tmp/.relay/runs/${runId}`,
    status: 'succeeded' as const,
    cost: { totalUsd: 0, totalTokens: 0 },
    artifacts: [],
    durationMs: 100,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  const flow = makeFlow();
  const provider = makeProvider();

  mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/flows/test-flow' }));
  mockParseInputFromArgv.mockReturnValue(ok({ input: '.' }));
  mockRegisterDefaultProviders.mockReturnValue(undefined);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockLoadFlowSettings.mockResolvedValue(ok(null));
  mockResolveProvider.mockReturnValue(ok(provider));
  mockRenderStartBanner.mockReturnValue('');
  mockRenderSuccessBanner.mockReturnValue('');
  mockRunnerRun.mockResolvedValue(makeRunResult());

  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay run — --fresh flag', () => {
  it('[RUN-FRESH-001] --fresh=true is forwarded to runner.run() as { fresh: true }', async () => {
    await expect(runCommand(['test-flow', '.'], { fresh: true })).rejects.toThrow(
      'process.exit called',
    );

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts.fresh).toBe(true);
  });

  it('[RUN-FRESH-002] without --fresh, fresh is not set in runner.run() options', async () => {
    await expect(runCommand(['test-flow', '.'], {})).rejects.toThrow('process.exit called');

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts.fresh).toBeUndefined();
  });

  it('[RUN-FRESH-003] --fresh=false does not set fresh in runner.run() options', async () => {
    await expect(runCommand(['test-flow', '.'], { fresh: false })).rejects.toThrow(
      'process.exit called',
    );

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts.fresh).toBeUndefined();
  });
});

describe('relay run — --provider flag forwarding', () => {
  it('[RUN-PROV-001] --provider is forwarded to runner.run() as flagProvider', async () => {
    await expect(runCommand(['test-flow', '.'], { provider: 'claude-cli' })).rejects.toThrow(
      'process.exit called',
    );

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts.flagProvider).toBe('claude-cli');
  });
});

describe('relay run — provider resolution failure', () => {
  it('[TC-020] exits early when no provider is configured (NoProviderConfiguredError)', async () => {
    mockResolveProvider.mockReturnValue(err(new NoProviderConfiguredError()));

    await expect(runCommand(['test-flow', '.'], {})).rejects.toThrow('process.exit called');

    // The runner must never be invoked — the command exits before reaching step 6.
    expect(mockRunnerRun).not.toHaveBeenCalled();

    // process.exit must have been called (the spy throws to capture the call).
    expect(process.exit).toHaveBeenCalledOnce();

    // Error detail must be written to stderr before exiting.
    expect(process.stderr.write).toHaveBeenCalled();
  });
});

describe('relay run — SIGINT paused banner', () => {
  it('[TC-021] aborted run after SIGINT renders paused banner and exits 130, not failure banner', async () => {
    // Make mockRunnerRun emit SIGINT mid-run then resolve with 'aborted'.
    // This simulates the Orchestrator aborting after Ctrl-C.
    mockRunnerRun.mockImplementation(() => {
      // Emit SIGINT synchronously inside the run — the sigintHandler registered
      // by the command sets wasInterrupted = true before orchestrator.run() resolves.
      process.emit('SIGINT');
      return Promise.resolve({
        runId: 'abc123',
        runDir: '/tmp/.relay/runs/abc123',
        status: 'aborted' as const,
        cost: { totalUsd: 0, totalTokens: 0 },
        artifacts: [],
        durationMs: 100,
      });
    });

    await expect(runCommand(['test-flow', '.'], {})).rejects.toThrow('process.exit called');

    // Paused banner must have been called.
    expect(vi.mocked(renderPausedBanner)).toHaveBeenCalledOnce();

    // Failure banner must NOT have been called.
    expect(vi.mocked(renderFailureBanner)).not.toHaveBeenCalled();

    // Exit code must be 130 (SIGINT convention).
    expect(process.exit).toHaveBeenCalledWith(130);
  });
});
