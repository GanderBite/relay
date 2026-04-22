import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import {
  RaceStateCorruptError,
  RaceStateNotFoundError,
  RaceStateTransitionError,
  RaceStateVersionMismatchError,
  RaceStateWriteError,
} from './errors.js';
import type { RaceState, RaceStatus, RunnerState } from './race/types.js';
import { atomicWriteJson } from './util/atomic-write.js';
import { parseWithSchema } from './util/json.js';
import { createWriteSerializer } from './util/serialize.js';
import { z } from './zod.js';

const STATE_FILENAME = 'state.json';

function nowIso(): string {
  return new Date().toISOString();
}

// Schema mirrors RunnerState from race/types.ts. The explicit z.ZodType<RunnerState>
// annotation forces a compile-time equivalence check — if race/types.ts adds a
// required field, this line fails typecheck.
const stepStateSchema: z.ZodType<RunnerState> = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  batons: z.array(z.string()).optional(),
});

// Schema mirrors RaceState from race/types.ts. `input: z.unknown()` matches the
// `unknown` typing in the type declaration — the race input shape is validated
// by the race's own Zod schema elsewhere, not by this state-file schema.
const RaceStateSchema: z.ZodType<RaceState> = z.object({
  runId: z.string(),
  raceName: z.string(),
  raceVersion: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'aborted']),
  startedAt: z.string(),
  updatedAt: z.string(),
  input: z.unknown(),
  runners: z.record(z.string(), stepStateSchema),
});

/**
 * RaceStateMachine owns the in-memory RaceState and the atomic persistence of
 * state.json. Every transition returns a Result — illegal transitions, unknown
 * step ids, and write failures surface as typed error variants rather than
 * thrown exceptions so callers can unwrap with neverthrow's combinators.
 */
export class RaceStateMachine {
  readonly #runDir: string;
  #state: RaceState;
  // Serializes concurrent save() calls so the on-disk snapshot is always a
  // monotonic prefix of the in-memory mutation history. Each save snapshots
  // the current state at the moment it runs (not at submission time), so
  // last-writer-wins matches the in-memory ordering.
  readonly #saveSerializer = createWriteSerializer();
  // In-memory cache of completed-step outcomes, keyed by runner id. Scoped to
  // the life of this RaceStateMachine instance — intentionally not serialized to
  // state.json. Used by the parallel executor on in-process retry so a parent
  // parallel runner that the Runner retries can reconstruct the results of
  // already-succeeded branches without re-dispatching them. A fresh resume in
  // another process starts with an empty cache; executors treat missing
  // entries as "no cached value" and rely on the on-disk runner status.
  readonly #runnerResults = new Map<string, unknown>();

  constructor(runDir: string, raceName: string, raceVersion: string, runId: string) {
    this.#runDir = runDir;
    const startedAt = nowIso();
    this.#state = {
      runId,
      raceName,
      raceVersion,
      startedAt,
      updatedAt: startedAt,
      input: undefined,
      runners: {},
      status: 'running',
    };
  }

  getState(): RaceState {
    return this.#state;
  }

  /**
   * Record a step's executor return value keyed by runner id. Callers invoke
   * this alongside completeRunner so downstream logic (currently the parallel
   * executor on retry) can read the value without re-dispatching.
   */
  recordRunnerResult(id: string, result: unknown): void {
    this.#runnerResults.set(id, result);
  }

  /**
   * Retrieve a previously-recorded step result, or `undefined` when none has
   * been recorded in this RaceStateMachine instance. A fresh process that resumed
   * from on-disk state starts with an empty cache, so a return of `undefined`
   * is not equivalent to "the step did not produce a value" — callers must
   * cross-check the step's persisted status to disambiguate.
   */
  getRunnerResult(id: string): unknown {
    return this.#runnerResults.get(id);
  }

  /**
   * Drop every cached step result. Invoked by the Runner on terminal run
   * completion to release references held by succeeded steps.
   */
  clearRunnerResults(): void {
    this.#runnerResults.clear();
  }

  get runDir(): string {
    return this.#runDir;
  }

  async init(runners: readonly string[]): Promise<Result<void, RaceStateWriteError>> {
    const seeded: Record<string, RunnerState> = {};
    for (const id of runners) {
      seeded[id] = { status: 'pending', attempts: 0 };
    }
    this.#state = { ...this.#state, runners: seeded, updatedAt: nowIso() };
    return this.save();
  }

  /**
   * Replace the in-memory state with a previously persisted snapshot — used
   * when resuming a run. Caller is responsible for invoking save() afterwards
   * if the mutation needs to land on disk. Skips the pending-step seeding
   * that `init()` performs so prior attempts/artifacts/batons survive.
   */
  hydrate(state: RaceState): void {
    this.#state = state;
  }

  startRunner(id: string): Result<void, RaceStateTransitionError> {
    const runnerResult = this.#requireStep(id);
    if (runnerResult.isErr()) return err(runnerResult.error);
    const runner = runnerResult.value;
    if (runner.status !== 'pending') {
      return err(
        new RaceStateTransitionError(
          `cannot start runner "${id}" from status "${runner.status}"`,
          id,
          { from: runner.status, attempted: 'start' },
        ),
      );
    }
    this.#updateStep(id, {
      ...runner,
      status: 'running',
      startedAt: nowIso(),
      attempts: (runner.attempts ?? 0) + 1,
    });
    return ok(undefined);
  }

  /**
   * Mark a step succeeded and persist its produced batons / artifacts on
   * RunnerState. Both arrays are independent — a step may write a baton with no
   * artifact file (the value lives in `batons/<id>.json`), an artifact with
   * no baton (the file lives at the path verbatim), or both. Resume and the
   * doctor command read both projections from RunnerState directly.
   */
  completeRunner(
    id: string,
    output: { batons?: readonly string[]; artifacts?: readonly string[] } = {},
  ): Result<void, RaceStateTransitionError> {
    const runnerResult = this.#requireStep(id);
    if (runnerResult.isErr()) return err(runnerResult.error);
    const runner = runnerResult.value;
    if (runner.status !== 'running') {
      return err(
        new RaceStateTransitionError(
          `cannot complete runner "${id}" from status "${runner.status}"`,
          id,
          { from: runner.status, attempted: 'complete' },
        ),
      );
    }
    const next: RunnerState = {
      ...runner,
      status: 'succeeded',
      completedAt: nowIso(),
    };
    if (output.batons !== undefined && output.batons.length > 0) {
      next.batons = [...output.batons];
    }
    if (output.artifacts !== undefined && output.artifacts.length > 0) {
      next.artifacts = [...output.artifacts];
    }
    this.#updateStep(id, next);
    return ok(undefined);
  }

  failRunner(id: string, error: string): Result<void, RaceStateTransitionError> {
    const runnerResult = this.#requireStep(id);
    if (runnerResult.isErr()) return err(runnerResult.error);
    const runner = runnerResult.value;
    if (runner.status !== 'running') {
      return err(
        new RaceStateTransitionError(
          `cannot fail runner "${id}" from status "${runner.status}"`,
          id,
          { from: runner.status, attempted: 'fail' },
        ),
      );
    }
    this.#updateStep(id, {
      ...runner,
      status: 'failed',
      completedAt: nowIso(),
      errorMessage: error,
    });
    // Intentionally does not touch run-level status. The Runner decides whether
    // a step failure escalates to a failed run based on the step's onFail
    // policy, and calls markRun('failed') explicitly when it does.
    return ok(undefined);
  }

  skipRunner(id: string): Result<void, RaceStateTransitionError> {
    const runnerResult = this.#requireStep(id);
    if (runnerResult.isErr()) return err(runnerResult.error);
    const runner = runnerResult.value;
    if (runner.status !== 'pending') {
      return err(
        new RaceStateTransitionError(
          `cannot skip runner "${id}" from status "${runner.status}"`,
          id,
          { from: runner.status, attempted: 'skip' },
        ),
      );
    }
    this.#updateStep(id, { ...runner, status: 'skipped' });
    return ok(undefined);
  }

  /**
   * Flip a previously-failed step back to pending so the Runner can retry it.
   * Preserves `attempts` so retry budgets survive resume — a step that used 2
   * of 3 attempts before a crash still has 1 attempt remaining on resume.
   * Clears `completedAt` and `errorMessage` from the prior failed attempt.
   */
  resetRunner(id: string): Result<void, RaceStateTransitionError> {
    const runnerResult = this.#requireStep(id);
    if (runnerResult.isErr()) return err(runnerResult.error);
    const runner = runnerResult.value;
    if (runner.status !== 'failed') {
      return err(
        new RaceStateTransitionError(
          `cannot reset runner "${id}" from status "${runner.status}"`,
          id,
          { from: runner.status, attempted: 'reset' },
        ),
      );
    }
    // Preserve the attempts counter so maxRetries budgets survive resume.
    // Drop startedAt/completedAt/errorMessage/artifacts/batons — a pending
    // step should read as never-started to any observer.
    const next: RunnerState = {
      status: 'pending',
      attempts: runner.attempts,
    };
    this.#updateStep(id, next);
    // A reset step will run again; any cached result from a prior attempt is
    // stale and must not leak into the next outcome.
    this.#runnerResults.delete(id);
    return ok(undefined);
  }

  /**
   * Transition the run-level status. When the target is a terminal failure
   * state ('failed' or 'aborted'), sweep any steps still in 'running' and flip
   * them to 'failed' with a descriptive errorMessage so the on-disk snapshot
   * is never left with a dangling running step after a crash or SIGINT.
   */
  markRun(status: RaceStatus): Result<void, RaceStateTransitionError> {
    const timestamp = nowIso();
    const shouldSweep = status === 'failed' || status === 'aborted';
    const sweepMessage = status === 'aborted' ? 'run aborted' : 'run failed';

    const nextRunners: Record<string, RunnerState> = { ...this.#state.runners };
    if (shouldSweep) {
      for (const [id, runner] of Object.entries(this.#state.runners)) {
        if (runner.status === 'running') {
          nextRunners[id] = {
            ...runner,
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
      runners: nextRunners,
      updatedAt: timestamp,
    };
    return ok(undefined);
  }

  /**
   * Persist the current state to disk via atomic rename so concurrent readers
   * never see a torn file. Every mutation that needs durability calls save()
   * explicitly — the transition methods themselves are pure in-memory updates.
   *
   * Concurrent save() calls are serialized through an in-process queue so
   * each on-disk snapshot is a monotonic prefix of the in-memory version
   * history. Two parallel steps completing within the same tick can each
   * call save(); the queue runs them in submission order and each one
   * snapshots the current state at execution time.
   */
  async save(): Promise<Result<void, RaceStateWriteError>> {
    return this.#saveSerializer(async () => {
      const writeResult = await atomicWriteJson(
        join(this.#runDir, STATE_FILENAME),
        this.#state,
      );
      if (writeResult.isErr()) {
        return err(
          new RaceStateWriteError(`failed to write state.json: ${writeResult.error.message}`, {
            cause: writeResult.error,
            errno: writeResult.error.errno,
            path: writeResult.error.path,
          }),
        );
      }
      return ok(undefined);
    });
  }

  /**
   * Thin wrapper over loadState. Use loadAndVerify when race-compat is required.
   */
  static async load(
    runDir: string,
  ): Promise<Result<RaceState, RaceStateNotFoundError | RaceStateCorruptError>> {
    return loadState(runDir);
  }

  /**
   * Canonical entry point for resuming a run: reads state.json, validates its
   * shape, and confirms the race name/version match before handing the RaceState
   * back. Returns `RaceStateNotFoundError` when the run directory has no state
   * file, `RaceStateCorruptError` when the file is unreadable/malformed/shape-
   * invalid, or `RaceStateVersionMismatchError` when the run was written by a
   * different race or version.
   */
  static async loadAndVerify(opts: {
    runDir: string;
    raceName: string;
    raceVersion: string;
  }): Promise<
    Result<RaceState, RaceStateNotFoundError | RaceStateCorruptError | RaceStateVersionMismatchError>
  > {
    const loadResult = await loadState(opts.runDir);
    if (loadResult.isErr()) return err(loadResult.error);
    const verifyResult = verifyCompatibility(loadResult.value, {
      raceName: opts.raceName,
      raceVersion: opts.raceVersion,
    });
    if (verifyResult.isErr()) return err(verifyResult.error);
    return ok(loadResult.value);
  }

  #requireStep(id: string): Result<RunnerState, RaceStateTransitionError> {
    const runner = this.#state.runners[id];
    if (runner === undefined) {
      return err(new RaceStateTransitionError(`unknown runner: ${id}`, id));
    }
    return ok(runner);
  }

  #updateStep(id: string, next: RunnerState): void {
    this.#state = {
      ...this.#state,
      runners: { ...this.#state.runners, [id]: next },
      updatedAt: nowIso(),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lower-level primitive. Most callers should use `RaceStateMachine.loadAndVerify`
 * which composes this with `verifyCompatibility` and correct error
 * discrimination. Reads state.json from runDir, parses it, and validates the
 * shape against RaceStateSchema. Missing file returns RaceStateNotFoundError so the
 * caller can treat ENOENT as "fresh run" without string-matching on error
 * messages. A malformed or shape-invalid file returns RaceStateCorruptError with
 * the parse reason in `details` for operator diagnostics.
 */
export async function loadState(
  runDir: string,
): Promise<Result<RaceState, RaceStateNotFoundError | RaceStateCorruptError>> {
  const filePath = join(runDir, STATE_FILENAME);
  const readResult = await ResultAsync.fromPromise(
    readFile(filePath, { encoding: 'utf8' }),
    (e) => e,
  );

  return readResult.match<Result<RaceState, RaceStateNotFoundError | RaceStateCorruptError>>(
    (raw) => {
      const parseResult = parseWithSchema(raw, RaceStateSchema);
      if (parseResult.isErr()) {
        const cause = parseResult.error.details?.['cause'];
        return err(
          new RaceStateCorruptError(`state.json is malformed: ${parseResult.error.message}`, {
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
        return err(new RaceStateNotFoundError('state.json not found', runDir));
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      return err(
        new RaceStateCorruptError(`state.json could not be read: ${message}`, { reason: message }),
      );
    },
  );
}

/**
 * Lower-level primitive. Most callers should use `RaceStateMachine.loadAndVerify`
 * which composes this with `loadState` and correct error discrimination.
 * Compares the on-disk RaceState against the currently-loaded race definition
 * and returns RaceStateVersionMismatchError (carrying both expected and actual
 * name/version pairs) when the run was written by a different race or a
 * different version. The Runner treats this as an unresumable run and
 * instructs the user to start over.
 */
export function verifyCompatibility(
  state: RaceState,
  expected: { raceName: string; raceVersion: string },
): Result<void, RaceStateVersionMismatchError> {
  if (state.raceName !== expected.raceName || state.raceVersion !== expected.raceVersion) {
    return err(
      new RaceStateVersionMismatchError(
        `run state is not compatible with this race: expected ${expected.raceName}@${expected.raceVersion}, found ${state.raceName}@${state.raceVersion}. Start a new run.`,
        expected,
        { raceName: state.raceName, raceVersion: state.raceVersion },
      ),
    );
  }
  return ok(undefined);
}
