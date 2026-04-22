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
const mockLoadRaceSettings = vi.hoisted(() => vi.fn());
const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockRenderStartBanner = vi.hoisted(() => vi.fn());
const mockRenderSuccessBanner = vi.hoisted(() => vi.fn());

vi.mock('@relay/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relay/core')>();
  return {
    ...actual,
    registerDefaultProviders: mockRegisterDefaultProviders,
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    loadRaceSettings: (_dir: string) => mockLoadRaceSettings(_dir),
    resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
    Orchestrator: class MockOrchestrator {
      constructor(_opts: unknown) {}
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
    constructor(_runDir: unknown, _flow: unknown, _auth: unknown) {}
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

import { ok } from '@relay/core';
import runCommand from '../../src/commands/run.js';

/** Minimal race object that satisfies the run command's needs. */
function makeFlow() {
  return {
    name: 'test-flow',
    version: '0.1.0',
    input: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    runnerOrder: ['step1'],
    runners: {},
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
  mockLoadRaceSettings.mockResolvedValue(ok(null));
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
    expect(runOpts['fresh']).toBe(true);
  });

  it('[RUN-FRESH-002] without --fresh, fresh is not set in runner.run() options', async () => {
    await expect(runCommand(['test-flow', '.'], {})).rejects.toThrow('process.exit called');

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts['fresh']).toBeUndefined();
  });

  it('[RUN-FRESH-003] --fresh=false does not set fresh in runner.run() options', async () => {
    await expect(runCommand(['test-flow', '.'], { fresh: false })).rejects.toThrow(
      'process.exit called',
    );

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts['fresh']).toBeUndefined();
  });
});

describe('relay run — --provider flag forwarding', () => {
  it('[RUN-PROV-001] --provider is forwarded to runner.run() as flagProvider', async () => {
    await expect(runCommand(['test-flow', '.'], { provider: 'claude-cli' })).rejects.toThrow(
      'process.exit called',
    );

    expect(mockRunnerRun).toHaveBeenCalledOnce();
    const runOpts = mockRunnerRun.mock.calls[0][2] as Record<string, unknown>;
    expect(runOpts['flagProvider']).toBe('claude-cli');
  });
});
