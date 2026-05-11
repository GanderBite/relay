/**
 * Tests for `relay resume <runId>` command helpers and early-exit paths.
 *
 * Covers:
 *  - firstPendingStepId: all-succeeded fallback, first-pending logic
 *  - Missing runId argument exit path
 *  - Paused-run rejection
 *  - Missing state.json (StateNotFoundError)
 *  - Null flowPath guard
 *
 * The Orchestrator, loadState, loadFlow and authenticateProvider are all
 * mocked — no live subprocess calls and no real filesystem I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockLoadState = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockLoadFlow = vi.hoisted(() => vi.fn());
const mockAuthenticateProvider = vi.hoisted(() => vi.fn());
const mockOrchestratorResume = vi.hoisted(() => vi.fn());
const mockCostTrackerLoad = vi.hoisted(() => vi.fn());
const mockCostTrackerSummary = vi.hoisted(() => vi.fn());
const mockProgressDisplayStart = vi.hoisted(() => vi.fn());
const mockProgressDisplayStop = vi.hoisted(() => vi.fn());
const mockProgressDisplayUpdateRunnerMetrics = vi.hoisted(() => vi.fn());
const mockAnswerCommand = vi.hoisted(() => vi.fn());

const mockStateNotFoundError = vi.hoisted(() => {
  class FakeStateNotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StateNotFoundError';
    }
  }
  return FakeStateNotFoundError;
});

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  return {
    ...actual,
    loadState: (...args: unknown[]) => mockLoadState(...args),
    StateNotFoundError: mockStateNotFoundError,
    CostTracker: class MockCostTracker {
      constructor(_path: string) {}
      load = mockCostTrackerLoad;
      summary = mockCostTrackerSummary;
    },
    Orchestrator: class MockOrchestrator {
      constructor(_opts: unknown) {}
      resume = mockOrchestratorResume;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
  FlowLoadError: class FlowLoadError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.name = 'FlowLoadError';
      this.code = code;
    }
  },
}));

vi.mock('../../src/load-flow-and-auth.js', () => ({
  authenticateProvider: (...args: unknown[]) => mockAuthenticateProvider(...args),
}));

vi.mock('../../src/progress.js', () => ({
  ProgressDisplay: class MockProgressDisplay {
    constructor(_runDir: unknown, _flow: unknown, _authInfo: unknown) {}
    start = mockProgressDisplayStart;
    stop = mockProgressDisplayStop;
    updateRunnerMetrics = mockProgressDisplayUpdateRunnerMetrics;
  },
}));

vi.mock('../../src/banner.js', () => ({
  renderSuccessBanner: () => 'success-banner\n',
  renderFailureBanner: () => 'failure-banner\n',
}));

vi.mock('../../src/paused-banner.js', () => ({
  renderPausedBanner: () => Promise.resolve(),
}));

vi.mock('../../src/step-data.js', () => ({
  buildSuccessStepRows: () => Promise.resolve([]),
  buildFailureStepRows: () => Promise.resolve([]),
}));

vi.mock('../../src/commands/answer.js', () => ({
  default: (...args: unknown[]) => mockAnswerCommand(...args),
}));

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import resumeCommand, { firstPendingStepId } from '../../src/commands/resume.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStepState(status: 'succeeded' | 'failed' | 'pending' | 'running' | 'skipped') {
  return { status, attempts: 1 };
}

function makeMinimalFlow(stepIds: string[]) {
  const steps: Record<string, unknown> = {};
  for (const id of stepIds) {
    steps[id] = { id, kind: 'script', run: 'echo ok' };
  }
  return {
    name: 'test-flow',
    version: '0.1.0',
    steps,
    graph: {
      topoOrder: stepIds,
      rootSteps: [stepIds[0] ?? ''],
      predecessors: new Map<string, Set<string>>(),
      successors: new Map<string, Set<string>>(),
    },
    input: undefined,
  };
}

function makeRunState(
  stepStatuses: Record<string, 'succeeded' | 'failed' | 'pending' | 'running' | 'skipped'>,
  topStatus: 'running' | 'failed' | 'succeeded' | 'paused' = 'running',
) {
  const steps: Record<string, ReturnType<typeof makeStepState>> = {};
  for (const [id, status] of Object.entries(stepStatuses)) {
    steps[id] = makeStepState(status);
  }
  return {
    runId: 'run-abc',
    flowName: 'test-flow',
    flowVersion: '0.1.0',
    status: topStatus,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    input: {},
    steps,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: CostTracker load succeeds, summary returns zero cost.
  mockCostTrackerLoad.mockResolvedValue(ok(undefined));
  mockCostTrackerSummary.mockReturnValue({ totalUsd: 0 });

  // Silence process I/O.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(process, 'removeListener').mockImplementation(() => process);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// firstPendingStepId — unit tests for the exported helper
// ---------------------------------------------------------------------------

describe('firstPendingStepId', () => {
  it('[RES-001] returns the last step when all steps have succeeded', () => {
    const topoOrder = ['inventory', 'entities', 'report'];
    const steps = {
      inventory: makeStepState('succeeded'),
      entities: makeStepState('succeeded'),
      report: makeStepState('succeeded'),
    };
    expect(firstPendingStepId(topoOrder, steps)).toBe('report');
  });

  it('[RES-002] returns the first non-succeeded step when some are pending', () => {
    const topoOrder = ['inventory', 'entities', 'report'];
    const steps = {
      inventory: makeStepState('succeeded'),
      entities: makeStepState('pending'),
      report: makeStepState('pending'),
    };
    expect(firstPendingStepId(topoOrder, steps)).toBe('entities');
  });

  it('[RES-003] returns the first step when none have started', () => {
    const topoOrder = ['a', 'b', 'c'];
    const steps = {
      a: makeStepState('pending'),
      b: makeStepState('pending'),
      c: makeStepState('pending'),
    };
    expect(firstPendingStepId(topoOrder, steps)).toBe('a');
  });

  it('[RES-004] treats "failed" as pending — returns the failed step', () => {
    const topoOrder = ['step1', 'step2', 'step3'];
    const steps = {
      step1: makeStepState('succeeded'),
      step2: makeStepState('failed'),
      step3: makeStepState('pending'),
    };
    expect(firstPendingStepId(topoOrder, steps)).toBe('step2');
  });

  it('[RES-005] skips "skipped" steps — only skipped and succeeded are considered done', () => {
    const topoOrder = ['a', 'b', 'c'];
    const steps = {
      a: makeStepState('skipped'),
      b: makeStepState('skipped'),
      c: makeStepState('pending'),
    };
    expect(firstPendingStepId(topoOrder, steps)).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// resumeCommand — early-exit paths
// ---------------------------------------------------------------------------

describe('relay resume — missing runId', () => {
  it('[RES-010] exits 1 when no runId argument is provided', async () => {
    await expect(resumeCommand([], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('relay resume requires a run id');
  });

  it('[RES-011] exits 1 when runId is whitespace-only', async () => {
    await expect(resumeCommand(['   '], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay resume — state load failures', () => {
  it('[RES-012] StateNotFoundError prints "no resumable run" and exits 1', async () => {
    mockLoadState.mockResolvedValue(err(new mockStateNotFoundError('state.json not found')));

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('no resumable run at abc123');
  });

  it('[RES-013] generic state load error prints message and exits 1', async () => {
    mockLoadState.mockResolvedValue(err(new Error('disk I/O failed')));

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('disk I/O failed');
  });
});

describe('relay resume — paused run rejection', () => {
  it('[RES-014] paused run exits 1 with relay answer guidance', async () => {
    const pausedState = makeRunState({ step1: 'pending' }, 'paused');
    mockLoadState.mockResolvedValue(ok(pausedState));

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    const combined = stderrCalls.join('');
    expect(combined).toContain('paused');
    expect(combined).toContain('relay answer abc123');
  });
});

describe('relay resume — flow-ref.json errors', () => {
  it('[RES-015] null flowPath guard exits 1 with "no recorded flow path"', async () => {
    mockLoadState.mockResolvedValue(ok(makeRunState({ step1: 'failed' })));
    // flow-ref.json is valid but flowPath is absent (null).
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        flowName: 'test-flow',
        flowVersion: '0.1.0',
        // flowPath intentionally omitted → becomes null
      }),
    );

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('no recorded flow path');
  });

  it('[RES-016] malformed flow-ref.json exits 1 with parse error message', async () => {
    mockLoadState.mockResolvedValue(ok(makeRunState({ step1: 'failed' })));
    mockReadFile.mockResolvedValue('{ not valid json');

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('could not load flow-ref.json');
  });
});

describe('relay resume — auth failure', () => {
  it('[RES-017] authenticateProvider failure exits with non-zero code', async () => {
    mockLoadState.mockResolvedValue(ok(makeRunState({ step1: 'failed' })));
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        flowName: 'test-flow',
        flowVersion: '0.1.0',
        flowPath: '/tmp/test-flow',
      }),
    );
    mockLoadFlow.mockResolvedValue(ok({ flow: makeMinimalFlow(['step1']), dir: '/tmp/test-flow' }));
    // CostTracker load returns error so spentUsd = 0 — no crash.
    mockCostTrackerLoad.mockResolvedValue(err(new Error('no metrics')));

    const authError = Object.assign(new Error('auth failed'), { name: 'SubscriptionAuthError' });
    mockAuthenticateProvider.mockResolvedValue(err(authError));

    await expect(resumeCommand(['abc123'], {})).rejects.toThrow('process.exit:');

    expect(process.exit).toHaveBeenCalled();
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('auth failed');
  });
});

// ---------------------------------------------------------------------------
// Shared setup for post-resume paused and verbose tests
// ---------------------------------------------------------------------------

/** Set up all mocks through to orchestrator.resume so the command reaches the
 * post-resume result branch. Accepts an override for the resume result. */
function setupSuccessfulResumePipeline(resumeResult: unknown): void {
  mockLoadState.mockResolvedValue(ok(makeRunState({ step1: 'failed' })));
  mockReadFile.mockResolvedValue(
    JSON.stringify({
      flowName: 'test-flow',
      flowVersion: '0.1.0',
      flowPath: '/tmp/test-flow',
    }),
  );
  mockLoadFlow.mockResolvedValue(ok({ flow: makeMinimalFlow(['step1']), dir: '/tmp/test-flow' }));
  mockCostTrackerLoad.mockResolvedValue(ok(undefined));
  mockCostTrackerSummary.mockReturnValue({ totalUsd: 0 });
  mockAuthenticateProvider.mockResolvedValue(
    ok({
      resolvedProvider: { name: 'claude-cli', capabilities: {} },
      authState: { ok: true, billingSource: 'subscription', detail: 'subscription (test)' },
    }),
  );
  mockOrchestratorResume.mockResolvedValue(resumeResult);
}

describe('relay resume — inline answer on pause', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    mockAnswerCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it('[C3] calls answerCommand inline when TTY and result is paused', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    setupSuccessfulResumePipeline({
      status: 'paused',
      pausedStepId: 'gather',
      runId: 'abc123',
      runDir: '/tmp/test-flow/abc123',
      cost: { totalUsd: 0, totalTokens: 0 },
      artifacts: [],
      durationMs: 0,
    });

    // answerCommand resolves without calling process.exit — command returns normally.
    await resumeCommand(['abc123'], {});

    expect(mockAnswerCommand).toHaveBeenCalledOnce();
    expect(mockAnswerCommand).toHaveBeenCalledWith(['abc123'], {});
    const exitCalls = vi.mocked(process.exit).mock.calls;
    const called75 = exitCalls.some((c) => c[0] === 75);
    expect(called75).toBe(false);
  });

  it('[C4] exits 75 when not TTY and result is paused', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    // Override process.exit to record the call without throwing so that the
    // process.exit(75) inside the try block does not get caught by the catch
    // handler and re-mapped to exit(1).
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      // Intentionally a no-op — we assert on the recorded call below.
      return undefined as never;
    });

    setupSuccessfulResumePipeline({
      status: 'paused',
      pausedStepId: 'gather',
      runId: 'abc123',
      runDir: '/tmp/test-flow/abc123',
      cost: { totalUsd: 0, totalTokens: 0 },
      artifacts: [],
      durationMs: 0,
    });

    await resumeCommand(['abc123'], {});

    expect(exitSpy).toHaveBeenCalledWith(75);
    expect(mockAnswerCommand).not.toHaveBeenCalled();
  });
});

describe('relay resume — verbose flag forwarding', () => {
  it('[D1] forwards verbose: true to orchestrator.resume when --verbose is set', async () => {
    setupSuccessfulResumePipeline({
      status: 'succeeded',
      runId: 'abc123',
      runDir: '/tmp/test-flow/abc123',
      cost: { totalUsd: 0, totalTokens: 0 },
      artifacts: [],
      durationMs: 100,
    });

    // The success path returns normally — no process.exit call.
    await resumeCommand(['abc123'], { verbose: true });

    expect(mockOrchestratorResume).toHaveBeenCalledOnce();
    const resumeOpts = mockOrchestratorResume.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(resumeOpts['verbose']).toBe(true);
  });

  it('[D2] does not set verbose when flag is absent', async () => {
    setupSuccessfulResumePipeline({
      status: 'succeeded',
      runId: 'abc123',
      runDir: '/tmp/test-flow/abc123',
      cost: { totalUsd: 0, totalTokens: 0 },
      artifacts: [],
      durationMs: 100,
    });

    // The success path returns normally — no process.exit call.
    await resumeCommand(['abc123'], {});

    expect(mockOrchestratorResume).toHaveBeenCalledOnce();
    const resumeOpts = mockOrchestratorResume.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(resumeOpts['verbose']).not.toBe(true);
  });
});
