import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import {
  StateCorruptError,
  StateNotFoundError,
  StateTransitionError,
  StateVersionMismatchError,
  StateWriteError,
} from './errors.js';
import type { RunState, RunStatus, StepState, StepStatus } from './flow/types.js';
import { atomicWriteJson } from './util/atomic-write.js';

const STATE_FILENAME = 'state.json';

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === 'running' || value === 'succeeded' || value === 'failed' || value === 'aborted'
  );
}

function isStepStatus(value: unknown): value is StepStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'skipped'
  );
}

function coerceStepState(value: unknown): StepState | undefined {
  if (!isRecord(value)) return undefined;
  const status = value['status'];
  const attempts = value['attempts'];
  if (!isStepStatus(status)) return undefined;
  if (typeof attempts !== 'number') return undefined;

  const step: StepState = { status, attempts };
  const startedAt = value['startedAt'];
  const completedAt = value['completedAt'];
  const errorMessage = value['errorMessage'];
  const artifacts = value['artifacts'];
  const handoffs = value['handoffs'];
  if (typeof startedAt === 'string') step.startedAt = startedAt;
  if (typeof completedAt === 'string') step.completedAt = completedAt;
  if (typeof errorMessage === 'string') step.errorMessage = errorMessage;
  if (Array.isArray(artifacts) && artifacts.every((a) => typeof a === 'string')) {
    step.artifacts = artifacts;
  }
  if (Array.isArray(handoffs) && handoffs.every((h) => typeof h === 'string')) {
    step.handoffs = handoffs;
  }
  return step;
}

function validateRunState(value: unknown): Result<RunState, string> {
  if (!isRecord(value)) return err('root is not an object');
  const runId = value['runId'];
  const flowName = value['flowName'];
  const flowVersion = value['flowVersion'];
  const startedAt = value['startedAt'];
  const updatedAt = value['updatedAt'];
  const status = value['status'];
  const stepsRaw = value['steps'];
  if (typeof runId !== 'string') return err('runId is not a string');
  if (typeof flowName !== 'string') return err('flowName is not a string');
  if (typeof flowVersion !== 'string') return err('flowVersion is not a string');
  if (typeof startedAt !== 'string') return err('startedAt is not a string');
  if (typeof updatedAt !== 'string') return err('updatedAt is not a string');
  if (!isRunStatus(status)) return err('status is not a valid RunStatus');
  if (!isRecord(stepsRaw)) return err('steps is not a record');

  const steps: Record<string, StepState> = {};
  for (const [id, raw] of Object.entries(stepsRaw)) {
    const step = coerceStepState(raw);
    if (step === undefined) return err(`step "${id}" is not a valid StepState`);
    steps[id] = step;
  }

  return ok({
    runId,
    flowName,
    flowVersion,
    startedAt,
    updatedAt,
    input: value['input'],
    steps,
    status,
  });
}

/**
 * StateMachine owns the in-memory RunState and the atomic persistence of
 * state.json. Every transition returns a Result — illegal transitions, unknown
 * step ids, and write failures surface as typed error variants rather than
 * thrown exceptions so callers can unwrap with neverthrow's combinators.
 */
export class StateMachine {
  readonly #runDir: string;
  #state: RunState;

  constructor(runDir: string, flowName: string, flowVersion: string, runId: string) {
    this.#runDir = runDir;
    const startedAt = nowIso();
    this.#state = {
      runId,
      flowName,
      flowVersion,
      startedAt,
      updatedAt: startedAt,
      input: undefined,
      steps: {},
      status: 'running',
    };
  }

  getState(): RunState {
    return this.#state;
  }

  get runDir(): string {
    return this.#runDir;
  }

  async init(steps: readonly string[]): Promise<Result<void, StateWriteError>> {
    const seeded: Record<string, StepState> = {};
    for (const id of steps) {
      seeded[id] = { status: 'pending', attempts: 0 };
    }
    this.#state = { ...this.#state, steps: seeded, updatedAt: nowIso() };
    return this.save();
  }

  startStep(id: string): Result<void, StateTransitionError> {
    const stepResult = this.#requireStep(id);
    if (stepResult.isErr()) return err(stepResult.error);
    const step = stepResult.value;
    if (step.status !== 'pending') {
      return err(
        new StateTransitionError(
          `cannot start step "${id}" from status "${step.status}"`,
          id,
          { from: step.status, attempted: 'start' },
        ),
      );
    }
    this.#updateStep(id, {
      ...step,
      status: 'running',
      startedAt: nowIso(),
      attempts: (step.attempts ?? 0) + 1,
    });
    return ok(undefined);
  }

  completeStep(
    id: string,
    artifacts?: Record<string, string>,
  ): Result<void, StateTransitionError> {
    const stepResult = this.#requireStep(id);
    if (stepResult.isErr()) return err(stepResult.error);
    const step = stepResult.value;
    if (step.status !== 'running') {
      return err(
        new StateTransitionError(
          `cannot complete step "${id}" from status "${step.status}"`,
          id,
          { from: step.status, attempted: 'complete' },
        ),
      );
    }
    const next: StepState = {
      ...step,
      status: 'succeeded',
      completedAt: nowIso(),
    };
    if (artifacts !== undefined) {
      // artifacts Record maps handoff ids -> artifact file paths. Persist both
      // projections so resume and doctor output can surface either view without
      // re-reading the record shape.
      next.handoffs = Object.keys(artifacts);
      next.artifacts = Object.values(artifacts);
    }
    this.#updateStep(id, next);
    return ok(undefined);
  }

  failStep(id: string, error: string): Result<void, StateTransitionError> {
    const stepResult = this.#requireStep(id);
    if (stepResult.isErr()) return err(stepResult.error);
    const step = stepResult.value;
    if (step.status !== 'running') {
      return err(
        new StateTransitionError(
          `cannot fail step "${id}" from status "${step.status}"`,
          id,
          { from: step.status, attempted: 'fail' },
        ),
      );
    }
    this.#updateStep(id, {
      ...step,
      status: 'failed',
      completedAt: nowIso(),
      errorMessage: error,
    });
    // Intentionally does not touch run-level status. The Runner decides whether
    // a step failure escalates to a failed run based on the step's onFail
    // policy, and calls markRun('failed') explicitly when it does.
    return ok(undefined);
  }

  skipStep(id: string): Result<void, StateTransitionError> {
    const stepResult = this.#requireStep(id);
    if (stepResult.isErr()) return err(stepResult.error);
    const step = stepResult.value;
    if (step.status !== 'pending') {
      return err(
        new StateTransitionError(
          `cannot skip step "${id}" from status "${step.status}"`,
          id,
          { from: step.status, attempted: 'skip' },
        ),
      );
    }
    this.#updateStep(id, { ...step, status: 'skipped' });
    return ok(undefined);
  }

  /**
   * Flip a previously-failed step back to pending so the Runner can retry it.
   * Preserves `attempts` so retry budgets survive resume — a step that used 2
   * of 3 attempts before a crash still has 1 attempt remaining on resume.
   * Clears `completedAt` and `errorMessage` from the prior failed attempt.
   */
  resetStep(id: string): Result<void, StateTransitionError> {
    const stepResult = this.#requireStep(id);
    if (stepResult.isErr()) return err(stepResult.error);
    const step = stepResult.value;
    if (step.status !== 'failed') {
      return err(
        new StateTransitionError(
          `cannot reset step "${id}" from status "${step.status}"`,
          id,
          { from: step.status, attempted: 'reset' },
        ),
      );
    }
    // Preserve the attempts counter so maxRetries budgets survive resume.
    // Drop startedAt/completedAt/errorMessage/artifacts/handoffs — a pending
    // step should read as never-started to any observer.
    const next: StepState = {
      status: 'pending',
      attempts: step.attempts,
    };
    this.#updateStep(id, next);
    return ok(undefined);
  }

  /**
   * Transition the run-level status. When the target is a terminal failure
   * state ('failed' or 'aborted'), sweep any steps still in 'running' and flip
   * them to 'failed' with a descriptive errorMessage so the on-disk snapshot
   * is never left with a dangling running step after a crash or SIGINT.
   */
  markRun(status: RunStatus): Result<void, StateTransitionError> {
    const timestamp = nowIso();
    const shouldSweep = status === 'failed' || status === 'aborted';
    const sweepMessage = status === 'aborted' ? 'run aborted' : 'run failed';

    const nextSteps: Record<string, StepState> = { ...this.#state.steps };
    if (shouldSweep) {
      for (const [id, step] of Object.entries(this.#state.steps)) {
        if (step.status === 'running') {
          nextSteps[id] = {
            ...step,
            status: 'failed',
            completedAt: timestamp,
            errorMessage: sweepMessage,
          };
        }
      }
    }
    this.#state = {
      ...this.#state,
      status,
      steps: nextSteps,
      updatedAt: timestamp,
    };
    return ok(undefined);
  }

  /**
   * Persist the current state to disk via atomic rename so concurrent readers
   * never see a torn file. Every mutation that needs durability calls save()
   * explicitly — the transition methods themselves are pure in-memory updates.
   */
  async save(): Promise<Result<void, StateWriteError>> {
    const writeResult = await atomicWriteJson(
      join(this.#runDir, STATE_FILENAME),
      this.#state,
    );
    if (writeResult.isErr()) {
      return err(
        new StateWriteError(`failed to write state.json: ${writeResult.error.message}`, {
          cause: writeResult.error.message,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Convenience: read state.json from disk and verify the RunState shape.
   * Does NOT call verifyCompatibility — the Runner performs that check.
   */
  static async load(
    runDir: string,
  ): Promise<Result<RunState, StateNotFoundError | StateCorruptError>> {
    return loadState(runDir);
  }

  #requireStep(id: string): Result<StepState, StateTransitionError> {
    const step = this.#state.steps[id];
    if (step === undefined) {
      return err(new StateTransitionError(`unknown step: ${id}`, id));
    }
    return ok(step);
  }

  #updateStep(id: string, next: StepState): void {
    this.#state = {
      ...this.#state,
      steps: { ...this.#state.steps, [id]: next },
      updatedAt: nowIso(),
    };
  }
}

/**
 * Read state.json from runDir, parse it, and validate the shape matches
 * RunState. Missing file returns StateNotFoundError so the caller can treat
 * ENOENT as "fresh run" without string-matching on error messages. A malformed
 * or shape-invalid file returns StateCorruptError with the parse reason in
 * `details` for operator diagnostics.
 */
export async function loadState(
  runDir: string,
): Promise<Result<RunState, StateNotFoundError | StateCorruptError>> {
  const filePath = join(runDir, STATE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: 'utf8' });
  } catch (e) {
    const code = isRecord(e) && typeof e['code'] === 'string' ? e['code'] : undefined;
    if (code === 'ENOENT') {
      return err(new StateNotFoundError('state.json not found', runDir));
    }
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new StateCorruptError(`state.json could not be read: ${message}`, { reason: message }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new StateCorruptError(`state.json is malformed: ${message}`, { reason: message }),
    );
  }

  const shapeResult = validateRunState(parsed);
  if (shapeResult.isErr()) {
    return err(
      new StateCorruptError(`state.json is malformed: ${shapeResult.error}`, {
        reason: shapeResult.error,
      }),
    );
  }
  return ok(shapeResult.value);
}

/**
 * Compare the on-disk RunState against the currently-loaded flow definition.
 * Returns StateVersionMismatchError (carrying both expected and actual
 * name/version pairs) when the run was written by a different flow or a
 * different version. The Runner treats this as an unresumable run and
 * instructs the user to start over.
 */
export function verifyCompatibility(
  state: RunState,
  expected: { flowName: string; flowVersion: string },
): Result<void, StateVersionMismatchError> {
  if (state.flowName !== expected.flowName || state.flowVersion !== expected.flowVersion) {
    return err(
      new StateVersionMismatchError(
        `run state is not compatible with this flow: expected ${expected.flowName}@${expected.flowVersion}, found ${state.flowName}@${state.flowVersion}. Start a new run.`,
        expected,
        { flowName: state.flowName, flowVersion: state.flowVersion },
      ),
    );
  }
  return ok(undefined);
}
