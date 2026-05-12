/**
 * Tests that answerCommand constructs and starts a ProgressDisplay when
 * process.stdout.isTTY is true, verifying the UI hang fix.
 *
 * Covers:
 *  - ProgressDisplay is constructed with (runDir, flow, authInfo, verbose)
 *  - display.start(runId) is called
 *  - 4th constructor argument (verbose) matches options.verbose === true
 *  - verbose=false when option is absent
 *  - paused-result recursion path (TTY mode, orchestrator returns paused)
 *  - interactive readline prompt path (questions array is non-empty)
 *  - failure-banner path (orchestrator returns failed)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist all mocks before the module-under-test loads.
// ---------------------------------------------------------------------------

const mockLoadState = vi.hoisted(() => vi.fn());
const mockAtomicWriteJson = vi.hoisted(() => vi.fn());
const mockStateMachineHydrate = vi.hoisted(() => vi.fn());
const mockStateMachineResumePausedStep = vi.hoisted(() => vi.fn());
const mockStateMachineSave = vi.hoisted(() => vi.fn());
const mockOrchestratorResume = vi.hoisted(() => vi.fn());
const mockRegisterDefaultProviders = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  return {
    ...actual,
    loadState: (...args: unknown[]) => mockLoadState(...args),
    atomicWriteJson: (...args: unknown[]) => mockAtomicWriteJson(...args),
    StateMachine: class MockStateMachine {
      hydrate = mockStateMachineHydrate;
      resumePausedStep = mockStateMachineResumePausedStep;
      save = mockStateMachineSave;
    },
    Orchestrator: class MockOrchestrator {
      resume = mockOrchestratorResume;
    },
    registerDefaultProviders: () => mockRegisterDefaultProviders(),
  };
});

// ---------------------------------------------------------------------------
// Mock node:fs/promises so flow-ref.json reads return a controlled payload.
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
    // mkdir is called fire-and-forget by ProgressDisplay.start() — keep it real
    // but silence any filesystem errors by providing a no-op.
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Mock ../load-flow-and-auth.js
// ---------------------------------------------------------------------------

const mockAuthenticateProvider = vi.hoisted(() => vi.fn());

vi.mock('../../src/load-flow-and-auth.js', () => ({
  authenticateProvider: (...args: unknown[]) => mockAuthenticateProvider(...args),
  loadFlowOnly: vi.fn(),
  loadFlowAndAuth: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ../flow-loader.js
// ---------------------------------------------------------------------------

const mockLoadFlow = vi.hoisted(() => vi.fn());

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
}));

// ---------------------------------------------------------------------------
// Mock ../paused-banner.js
// ---------------------------------------------------------------------------

vi.mock('../../src/paused-banner.js', () => ({
  renderPausedBanner: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock ../banner.js
// ---------------------------------------------------------------------------

vi.mock('../../src/banner.js', () => ({
  renderSuccessBanner: vi.fn().mockReturnValue('success-banner\n'),
  renderFailureBanner: vi.fn().mockReturnValue('failure-banner\n'),
}));

// ---------------------------------------------------------------------------
// Mock ../step-data.js
// ---------------------------------------------------------------------------

vi.mock('../../src/step-data.js', () => ({
  buildSuccessStepRows: vi.fn().mockResolvedValue([]),
  buildFailureStepRows: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock answer-prompt.js — allows the interactive-prompt path to be exercised
// without a real readline TTY. The hoisted fn references are reset per test.
// ---------------------------------------------------------------------------

const mockMakeReadline = vi.hoisted(() => vi.fn());
const mockAskQuestion = vi.hoisted(() => vi.fn());
const mockCollectMissingRequired = vi.hoisted(() => vi.fn());

vi.mock('../../src/commands/answer-prompt.js', () => ({
  makeReadline: (...args: unknown[]) => mockMakeReadline(...args),
  askQuestion: (...args: unknown[]) => mockAskQuestion(...args),
  collectMissingRequired: (...args: unknown[]) => mockCollectMissingRequired(...args),
}));

// ---------------------------------------------------------------------------
// ProgressDisplay mock — captures constructor args and start() calls.
// This is the system under observation for these tests.
// ---------------------------------------------------------------------------

const mockProgressDisplayStart = vi.hoisted(() => vi.fn());
const mockProgressDisplayStop = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockProgressDisplayUpdateRunnerMetrics = vi.hoisted(() => vi.fn());

// Track every constructor invocation: each call pushes its args.
const progressDisplayConstructorCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../src/progress.js', () => {
  class MockProgressDisplay {
    constructor(...args: unknown[]) {
      progressDisplayConstructorCalls.push(args);
    }
    start = mockProgressDisplayStart;
    stop = mockProgressDisplayStop;
    updateRunnerMetrics = mockProgressDisplayUpdateRunnerMetrics;
    onSigint = vi.fn();
  }
  return { ProgressDisplay: MockProgressDisplay };
});

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { ok } from '@ganderbite/relay-core';
import answerCommand from '../../src/commands/answer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLOW_REF_JSON = JSON.stringify({
  flowName: 'test-flow',
  flowVersion: '0.0.1',
  flowPath: '/fake/flows/test-flow/flow.ts',
});

function makeAuthState() {
  return {
    billingSource: 'subscription' as const,
    warning: undefined,
  };
}

function makeResolvedProvider(name = 'claude-cli') {
  return { name };
}

function makePausedState(stepId = 'gather', questions: unknown[] = []) {
  return {
    runId: 'run-xyz',
    flowName: 'test-flow',
    flowVersion: '0.0.1',
    status: 'paused' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    input: {},
    steps: {
      [stepId]: { status: 'paused' as const, attempts: 1 },
    },
    awaitingInput: {
      stepId,
      questions,
      promptedAt: '2026-01-01T00:00:01.000Z',
    },
  };
}

function makePausedResult(pausedStepId = 'gather') {
  return {
    runId: 'run-xyz',
    runDir: '/tmp/.relay/runs/run-xyz',
    status: 'paused' as const,
    cost: { totalUsd: 0, totalTokens: 0 },
    artifacts: [],
    durationMs: 50,
    pausedStepId,
  };
}

function makeFailedResult() {
  return {
    runId: 'run-xyz',
    runDir: '/tmp/.relay/runs/run-xyz',
    status: 'failed' as const,
    cost: { totalUsd: 0, totalTokens: 0 },
    artifacts: [],
    durationMs: 50,
    firstError: new Error('step failed'),
  };
}

function makeSucceededResult() {
  return {
    runId: 'run-xyz',
    runDir: '/tmp/.relay/runs/run-xyz',
    status: 'succeeded' as const,
    cost: { totalUsd: 0, totalTokens: 0 },
    artifacts: [],
    durationMs: 50,
  };
}

function makeMinimalFlow() {
  return {
    name: 'test-flow',
    version: '0.0.1',
    graph: { topoOrder: ['gather'] },
    steps: {
      gather: { id: 'gather', kind: 'prompt', promptFile: 'p.md' },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Reset the constructor call log.
  progressDisplayConstructorCalls.length = 0;

  // Default: state machine transitions succeed.
  mockStateMachineResumePausedStep.mockReturnValue(ok(undefined));
  mockStateMachineSave.mockResolvedValue(ok(undefined));
  mockAtomicWriteJson.mockResolvedValue(ok(undefined));

  // Default: orchestrator resume returns succeeded.
  mockOrchestratorResume.mockResolvedValue(makeSucceededResult());

  // Default: flow-ref.json reads as valid JSON.
  mockReadFile.mockResolvedValue(FLOW_REF_JSON);

  // Default: authentication succeeds.
  mockAuthenticateProvider.mockResolvedValue(
    ok({ resolvedProvider: makeResolvedProvider(), authState: makeAuthState() }),
  );

  // Default: registerDefaultProviders is a no-op.
  mockRegisterDefaultProviders.mockReturnValue(undefined);

  // Default: loadFlow returns a minimal flow.
  mockLoadFlow.mockResolvedValue(ok({ flow: makeMinimalFlow(), dir: '/fake/flows/test-flow' }));

  // Default stop() resolves immediately.
  mockProgressDisplayStop.mockResolvedValue(undefined);

  // Default answer-prompt mocks: no readline needed, no questions.
  const fakeRl = { close: vi.fn(), question: vi.fn() };
  mockMakeReadline.mockReturnValue(fakeRl);
  mockAskQuestion.mockResolvedValue('test-answer');
  mockCollectMissingRequired.mockReturnValue([]);

  // Silence process I/O.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  // Stub SIGINT registration so answerCommand's process.on('SIGINT') is a no-op.
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(process, 'removeListener').mockImplementation(() => process);

  // Stub TTY flags — pretend we are in a real terminal.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();

  // Restore TTY flags to their original (undefined/false) state.
  Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('answerCommand — ProgressDisplay wiring (TTY mode)', () => {
  it('[ANS-PD-001] constructs ProgressDisplay when TTY and loadFlow succeeds', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    // ProgressDisplay must have been constructed exactly once.
    expect(progressDisplayConstructorCalls).toHaveLength(1);
  });

  it('[ANS-PD-002] calls display.start(runId) after construction', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    expect(mockProgressDisplayStart).toHaveBeenCalledOnce();
    expect(mockProgressDisplayStart).toHaveBeenCalledWith('run-xyz');
  });

  it('[ANS-PD-003] 4th constructor argument (verbose) is false when options.verbose is absent', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    // No verbose option passed.
    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    expect(progressDisplayConstructorCalls).toHaveLength(1);
    const ctorArgs = progressDisplayConstructorCalls[0]!;
    // Constructor signature: (runDir, flow, authInfo, verbose)
    expect(ctorArgs[3]).toBe(false);
  });

  it('[ANS-PD-004] 4th constructor argument (verbose) is true when options.verbose === true', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    await expect(answerCommand(['run-xyz'], { verbose: true })).resolves.toBeUndefined();

    expect(progressDisplayConstructorCalls).toHaveLength(1);
    const ctorArgs = progressDisplayConstructorCalls[0]!;
    expect(ctorArgs[3]).toBe(true);
  });

  it('[ANS-PD-005] 4th constructor argument (verbose) is false when options.verbose is false', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    await expect(answerCommand(['run-xyz'], { verbose: false })).resolves.toBeUndefined();

    expect(progressDisplayConstructorCalls).toHaveLength(1);
    const ctorArgs = progressDisplayConstructorCalls[0]!;
    expect(ctorArgs[3]).toBe(false);
  });

  it('[ANS-PD-006] display.stop() is called after orchestrator.resume resolves', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    expect(mockProgressDisplayStop).toHaveBeenCalledOnce();
  });

  it('[ANS-PD-007] ProgressDisplay is NOT constructed when loadFlow fails (fallback branch)', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));
    // Force loadFlow to fail — triggers the bare-orchestrator fallback path.
    mockLoadFlow.mockResolvedValue({ isErr: () => true, isOk: () => false });
    // Bare orchestrator.resume in the fallback path returns succeeded.
    mockOrchestratorResume.mockResolvedValue(makeSucceededResult());

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    // The fallback branch does not construct ProgressDisplay.
    expect(progressDisplayConstructorCalls).toHaveLength(0);
    expect(mockProgressDisplayStart).not.toHaveBeenCalled();
  });

  it('[ANS-PD-paused-recursion] recursive answerCommand is invoked when orchestrator returns paused in TTY mode', async () => {
    // First call: state is paused, loadState returns paused state.
    // Second call (recursive): loadState returns the same paused state; orchestrator returns succeeded.
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));

    // First orchestrator.resume returns paused → triggers the recursion branch.
    // Second orchestrator.resume (from recursive answerCommand call) returns succeeded.
    mockOrchestratorResume
      .mockResolvedValueOnce(makePausedResult('gather'))
      .mockResolvedValue(makeSucceededResult());

    // Capture stdout writes so we can verify the "answering inline" message.
    const writtenChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writtenChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    // The "answering inline" line must have been written — proof the branch executed.
    const allOutput = writtenChunks.join('');
    expect(allOutput).toContain('paused for input — answering inline');

    // The orchestrator must have been called twice: once for the initial run,
    // once for the recursive answerCommand call.
    expect(mockOrchestratorResume).toHaveBeenCalledTimes(2);
  });

  it('[ANS-PD-interactive-prompt] readline prompt is invoked when questions array is non-empty', async () => {
    const question = { id: 'q1', kind: 'text' as const, label: 'What is your name?' };
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', [question])));
    mockOrchestratorResume.mockResolvedValue(makeSucceededResult());

    // The mock askQuestion returns a synthesised answer.
    mockAskQuestion.mockResolvedValue('relay-user');

    // Fake readline interface — close() is called in the finally block.
    const fakeRl = { close: vi.fn(), question: vi.fn() };
    mockMakeReadline.mockReturnValue(fakeRl);

    await expect(answerCommand(['run-xyz'], {})).resolves.toBeUndefined();

    // makeReadline must have been called to open the interface.
    expect(mockMakeReadline).toHaveBeenCalledOnce();

    // askQuestion must have been called with the rl and the question.
    expect(mockAskQuestion).toHaveBeenCalledOnce();
    expect(mockAskQuestion).toHaveBeenCalledWith(fakeRl, question);

    // The rl must have been closed in the finally block.
    expect(fakeRl.close).toHaveBeenCalledOnce();

    // The answer handoff must have been written with the synthesised answer.
    expect(mockAtomicWriteJson).toHaveBeenCalledWith(
      expect.stringContaining('__ask_'),
      expect.objectContaining({ q1: 'relay-user' }),
    );
  });

  it('[ANS-PD-failure] renderFailureBanner is called and process exits 1 when orchestrator returns failed', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather')));
    mockOrchestratorResume.mockResolvedValue(makeFailedResult());

    // process.exit is already mocked to throw in beforeEach; catch that throw.
    await expect(answerCommand(['run-xyz'], {})).rejects.toThrow('process.exit called');

    // renderFailureBanner from banner.js must have been called once.
    const { renderFailureBanner } = await import('../../src/banner.js');
    expect(vi.mocked(renderFailureBanner)).toHaveBeenCalledOnce();
    expect(vi.mocked(renderFailureBanner)).toHaveBeenCalledWith(
      expect.objectContaining({
        flowName: 'test-flow',
        runId: 'run-xyz',
      }),
    );

    // process.exit must have been called with exit code 1.
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1);
  });
});
