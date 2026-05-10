/**
 * Tests for `relay answer` command.
 *
 * Covers: non-paused run rejection, --json mode (valid, missing required,
 * malformed JSON), empty-question auto-resume, and resume outcome paths
 * (succeeded and re-paused). All orchestrator and state I/O is mocked — no
 * live Claude subprocess calls and no real filesystem writes outside temp dirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist all mocks before the module-under-test loads.
// ---------------------------------------------------------------------------

const mockLoadState = vi.hoisted(() => vi.fn());
const mockAtomicWriteJson = vi.hoisted(() => vi.fn());
const mockStateNotFoundError = vi.hoisted(() => {
  class FakeStateNotFoundError extends Error {
    constructor(msg: string, _runDir?: string) {
      super(msg);
      this.name = 'StateNotFoundError';
    }
  }
  return FakeStateNotFoundError;
});
const mockStateMachineHydrate = vi.hoisted(() => vi.fn());
const mockStateMachineResumePausedStep = vi.hoisted(() => vi.fn());
const mockStateMachineSave = vi.hoisted(() => vi.fn());
const mockOrchestratorResume = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  return {
    ...actual,
    loadState: (...args: unknown[]) => mockLoadState(...args),
    atomicWriteJson: (...args: unknown[]) => mockAtomicWriteJson(...args),
    StateNotFoundError: mockStateNotFoundError,
    StateMachine: class MockStateMachine {
      hydrate = mockStateMachineHydrate;
      resumePausedStep = mockStateMachineResumePausedStep;
      save = mockStateMachineSave;
    },
    Orchestrator: class MockOrchestrator {
      resume = mockOrchestratorResume;
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import answerCommand from '../../src/commands/answer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RunState that reports status:paused with one paused step. */
function makePausedState(
  stepId = 'gather',
  questions: Array<{ id: string; kind: string; label: string; required?: boolean }> = [],
) {
  return {
    runId: 'run-abc',
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

/** Build a RunState with the given top-level status and no awaitingInput. */
function makeNonPausedState(
  status: 'running' | 'succeeded' | 'failed' | 'aborted',
  stepId = 'step1',
) {
  return {
    runId: 'run-abc',
    flowName: 'test-flow',
    flowVersion: '0.0.1',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    input: {},
    steps: {
      [stepId]: { status: status === 'running' ? 'running' : 'succeeded', attempts: 1 },
    },
  };
}

function makeRunResult(
  status: 'succeeded' | 'paused' | 'failed' | 'aborted',
  pausedStepId?: string,
) {
  return {
    runId: 'run-abc',
    runDir: '/tmp/.relay/runs/run-abc',
    status,
    cost: { totalUsd: 0, totalTokens: 0 },
    artifacts: [],
    durationMs: 50,
    pausedStepId,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: state machine transitions succeed.
  mockStateMachineResumePausedStep.mockReturnValue(ok(undefined));
  mockStateMachineSave.mockResolvedValue(ok(undefined));
  mockAtomicWriteJson.mockResolvedValue(ok(undefined));

  // Default orchestrator resume: success.
  mockOrchestratorResume.mockResolvedValue(makeRunResult('succeeded'));

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
// Non-paused run rejection
// ---------------------------------------------------------------------------

describe('relay answer — non-paused run rejection', () => {
  it('[ANS-001] run with status:succeeded prints warning and exits 1', async () => {
    mockLoadState.mockResolvedValue(ok(makeNonPausedState('succeeded')));

    await expect(answerCommand(['run-abc'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
    // Warn line must mention the run id and "not paused".
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    const warnLine = stderrCalls.join('');
    expect(warnLine).toContain('run-abc');
    expect(warnLine).toContain('not paused');
    // Orchestrator must not be invoked.
    expect(mockOrchestratorResume).not.toHaveBeenCalled();
  });

  it('[ANS-002] run with status:running prints warning and exits 1', async () => {
    mockLoadState.mockResolvedValue(ok(makeNonPausedState('running')));

    await expect(answerCommand(['run-abc'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('not paused');
    expect(mockOrchestratorResume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// --json mode
// ---------------------------------------------------------------------------

describe('relay answer — --json mode', () => {
  it('[ANS-003] valid --json with all required answers writes handoff and triggers resume', async () => {
    const questions = [
      { id: 'name', kind: 'text' as const, label: 'Your name?', required: true as const },
      { id: 'age', kind: 'number' as const, label: 'Your age?', required: true as const },
    ];
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', questions)));

    const jsonStr = JSON.stringify({ name: 'Alice', age: 30 });

    await expect(answerCommand(['run-abc'], { json: jsonStr })).resolves.toBeUndefined();

    // atomicWriteJson must have been called with the expected answer contents.
    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [writtenPath, writtenAnswers] = mockAtomicWriteJson.mock.calls[0] as [string, unknown];
    expect(writtenPath).toContain('__ask_gather__');
    expect(writtenPath).toContain('handoffs');
    expect(writtenAnswers).toEqual({ name: 'Alice', age: 30 });

    // StateMachine transitions must have been applied.
    expect(mockStateMachineResumePausedStep).toHaveBeenCalledWith('gather');
    expect(mockStateMachineSave).toHaveBeenCalledOnce();

    // Orchestrator must have resumed.
    expect(mockOrchestratorResume).toHaveBeenCalledOnce();

    // No error exit.
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('[ANS-004] --json missing a required answer prints error message and exits 1', async () => {
    const questions = [
      { id: 'name', kind: 'text' as const, label: 'Your name?', required: true as const },
      { id: 'city', kind: 'text' as const, label: 'Your city?', required: true as const },
    ];
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', questions)));

    // Provide only 'name', omit 'city'.
    const jsonStr = JSON.stringify({ name: 'Alice' });

    await expect(answerCommand(['run-abc'], { json: jsonStr })).rejects.toThrow(
      'process.exit called',
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    const combined = stderrCalls.join('');
    expect(combined).toContain('missing answers for:');
    expect(combined).toContain('city');
    // Orchestrator must not be invoked.
    expect(mockOrchestratorResume).not.toHaveBeenCalled();
    expect(mockAtomicWriteJson).not.toHaveBeenCalled();
  });

  it('[ANS-005] --json with malformed JSON prints parse error and exits 1', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', [])));

    await expect(answerCommand(['run-abc'], { json: '{not valid json' })).rejects.toThrow(
      'process.exit called',
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('not valid JSON');
    expect(mockOrchestratorResume).not.toHaveBeenCalled();
    expect(mockAtomicWriteJson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty questions
// ---------------------------------------------------------------------------

describe('relay answer — empty questions', () => {
  it('[ANS-006] paused run with 0 questions writes empty handoff and resumes automatically', async () => {
    // No questions array — awaitingInput.questions is empty.
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', [])));

    await expect(answerCommand(['run-abc'], {})).resolves.toBeUndefined();

    // Empty handoff must be written.
    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [, writtenAnswers] = mockAtomicWriteJson.mock.calls[0] as [string, unknown];
    expect(writtenAnswers).toEqual({});

    expect(mockOrchestratorResume).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resume outcome paths
// ---------------------------------------------------------------------------

describe('relay answer — resume outcomes', () => {
  it('[ANS-007] orchestrator returns succeeded: prints success message and exits 0', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', [])));
    mockOrchestratorResume.mockResolvedValue(makeRunResult('succeeded'));

    await expect(answerCommand(['run-abc'], {})).resolves.toBeUndefined();

    // Success line must appear on stdout.
    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    expect(stdoutCalls.join('')).toContain('run-abc');
    expect(stdoutCalls.join('')).toContain('completed');
    // No non-zero exit.
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('[ANS-008] orchestrator returns paused again: prints warning and exits 75', async () => {
    mockLoadState.mockResolvedValue(ok(makePausedState('gather', [])));
    mockOrchestratorResume.mockResolvedValue(makeRunResult('paused', 'next-step'));

    await expect(answerCommand(['run-abc'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(75);
    // Warn message must mention the paused step and guidance to call relay answer again.
    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const combined = stdoutCalls.join('');
    expect(combined).toContain('paused again');
    expect(combined).toContain('next-step');
    expect(combined).toContain('relay answer run-abc');
  });
});

// ---------------------------------------------------------------------------
// Loop body ask path routing
// ---------------------------------------------------------------------------

describe('relay answer — loop body ask path routing', () => {
  it('writes iteration-scoped path when loopStepId and loopIter are set', async () => {
    const loopState = {
      runId: 'run-abc',
      flowName: 'test-flow',
      flowVersion: '0.0.1',
      status: 'paused' as const,
      startedAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:01.000Z',
      input: {},
      steps: {
        'fix_loop::feedback': { status: 'paused' as const, attempts: 1 },
      },
      awaitingInput: {
        stepId: 'fix_loop::feedback',
        loopStepId: 'fix_loop',
        loopIter: 1,
        questions: [{ id: 'q', kind: 'text' as const, label: 'Test' }],
        promptedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    mockLoadState.mockResolvedValue(ok(loopState));

    const jsonStr = JSON.stringify({ q: 'answer' });
    await expect(answerCommand(['run-abc'], { json: jsonStr })).resolves.toBeUndefined();

    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [writtenPath] = mockAtomicWriteJson.mock.calls[0] as [string, unknown];
    expect(writtenPath).toContain('handoffs');
    expect(writtenPath).toContain('fix_loop');
    expect(writtenPath).toContain('iter_1');
    expect(writtenPath).toContain('__ask_feedback__');
  });

  it('uses top-level path when loopStepId is absent', async () => {
    const flatState = {
      runId: 'run-abc',
      flowName: 'test-flow',
      flowVersion: '0.0.1',
      status: 'paused' as const,
      startedAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:01.000Z',
      input: {},
      steps: {
        gather: { status: 'paused' as const, attempts: 1 },
      },
      awaitingInput: {
        stepId: 'gather',
        questions: [{ id: 'q', kind: 'text' as const, label: 'Test' }],
        promptedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    mockLoadState.mockResolvedValue(ok(flatState));

    const jsonStr = JSON.stringify({ q: 'answer' });
    await expect(answerCommand(['run-abc'], { json: jsonStr })).resolves.toBeUndefined();

    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [writtenPath] = mockAtomicWriteJson.mock.calls[0] as [string, unknown];
    expect(writtenPath).toContain('handoffs');
    expect(writtenPath).toContain('__ask_gather__');
    // Must NOT contain iteration-scoped path segments.
    expect(writtenPath).not.toContain('iter_');
  });
});

// ---------------------------------------------------------------------------
// State not found
// ---------------------------------------------------------------------------

describe('relay answer — missing run', () => {
  it('[ANS-009] state not found prints error and exits 1', async () => {
    mockLoadState.mockResolvedValue(
      err(new mockStateNotFoundError('state.json not found', '/some/dir')),
    );

    await expect(answerCommand(['run-abc'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.join('')).toContain('run-abc');
    expect(mockOrchestratorResume).not.toHaveBeenCalled();
  });
});
