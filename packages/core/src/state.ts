import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import {
  StateCorruptError,
  StateNotFoundError,
  StateTransitionError,
  StateVersionMismatchError,
  StateWriteError,
} from './errors.js';
import type { RunState, RunStatus, StepState } from './flow/types.js';
import { atomicWriteJson } from './util/atomic-write.js';
import { parseWithSchema } from './util/json.js';
import { z } from './zod.js';

const STATE_FILENAME = 'state.json';

function nowIso(): string {
  return new Date().toISOString();
}

// Schema mirrors StepState from flow/types.ts. The explicit z.ZodType<StepState>
// annotation forces a compile-time equivalence check — if flow/types.ts adds a
// required field, this line fails typecheck.
const stepStateSchema: z.ZodType<StepState> = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  handoffs: z.array(z.string()).optional(),
});

// Schema mirrors RunState from flow/types.ts. `input: z.unknown()` matches the
// `unknown` typing in the type declaration — the flow input shape is validated
// by the flow's own Zod schema elsewhere, not by this state-file schema.
const RunStateSchema: z.ZodType<RunState> = z.object({
  runId: z.string(),
  flowName: z.string(),
  flowVersion: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'aborted']),
  startedAt: z.string(),
  updatedAt: z.string(),
  input: z.unknown(),
  steps: z.record(z.string(), stepStateSchema),
});

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
   * Thin wrapper over loadState. Use loadAndVerify when flow-compat is required.
   */
  static async load(
    runDir: string,
  ): Promise<Result<RunState, StateNotFoundError | StateCorruptError>> {
    return loadState(runDir);
  }

  /**
   * Canonical entry point for resuming a run: reads state.json, validates its
   * shape, and confirms the flow name/version match before handing the RunState
   * back. Returns `StateNotFoundError` when the run directory has no state
   * file, `StateCorruptError` when the file is unreadable/malformed/shape-
   * invalid, or `StateVersionMismatchError` when the run was written by a
   * different flow or version.
   */
  static async loadAndVerify(opts: {
    runDir: string;
    flowName: string;
    flowVersion: string;
  }): Promise<
    Result<RunState, StateNotFoundError | StateCorruptError | StateVersionMismatchError>
  > {
    const loadResult = await loadState(opts.runDir);
    if (loadResult.isErr()) return err(loadResult.error);
    const verifyResult = verifyCompatibility(loadResult.value, {
      flowName: opts.flowName,
      flowVersion: opts.flowVersion,
    });
    if (verifyResult.isErr()) return err(verifyResult.error);
    return ok(loadResult.value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lower-level primitive. Most callers should use `StateMachine.loadAndVerify`
 * which composes this with `verifyCompatibility` and correct error
 * discrimination. Reads state.json from runDir, parses it, and validates the
 * shape against RunStateSchema. Missing file returns StateNotFoundError so the
 * caller can treat ENOENT as "fresh run" without string-matching on error
 * messages. A malformed or shape-invalid file returns StateCorruptError with
 * the parse reason in `details` for operator diagnostics.
 */
export async function loadState(
  runDir: string,
): Promise<Result<RunState, StateNotFoundError | StateCorruptError>> {
  const filePath = join(runDir, STATE_FILENAME);
  const readResult = await ResultAsync.fromPromise(
    readFile(filePath, { encoding: 'utf8' }),
    (e) => e,
  );

  return readResult.match<Result<RunState, StateNotFoundError | StateCorruptError>>(
    (raw) => {
      const parseResult = parseWithSchema(raw, RunStateSchema);
      if (parseResult.isErr()) {
        const cause = parseResult.error.details?.['cause'];
        return err(
          new StateCorruptError(`state.json is malformed: ${parseResult.error.message}`, {
            reason: parseResult.error.message,
            cause,
          }),
        );
      }
      return ok(parseResult.value);
    },
    (caught) => {
      const code = isRecord(caught) && typeof caught['code'] === 'string' ? caught['code'] : undefined;
      if (code === 'ENOENT') {
        return err(new StateNotFoundError('state.json not found', runDir));
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      return err(
        new StateCorruptError(`state.json could not be read: ${message}`, { reason: message }),
      );
    },
  );
}

/**
 * Lower-level primitive. Most callers should use `StateMachine.loadAndVerify`
 * which composes this with `loadState` and correct error discrimination.
 * Compares the on-disk RunState against the currently-loaded flow definition
 * and returns StateVersionMismatchError (carrying both expected and actual
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
