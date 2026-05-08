import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import {
  FlowDefinitionError,
  HandoffIoError,
  HandoffNotFoundError,
  HandoffSchemaError,
  HandoffWriteError,
} from './errors.js';
import { atomicWriteJson } from './util/atomic-write.js';
import { parseWithSchema, safeParse } from './util/json.js';
import type { z } from './zod.js';

// Non-empty id that starts alphanumeric and may continue with alphanumerics, dot, underscore, dash.
// Rejects path separators, parent-dir segments, hidden-file leading dot, and any ASCII control chars.
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateHandoffId(id: string): Result<void, FlowDefinitionError> {
  if (
    id.length === 0 ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('..') ||
    id.startsWith('.') ||
    hasControlChar(id) ||
    !HANDOFF_ID_PATTERN.test(id)
  ) {
    return err(new FlowDefinitionError(`invalid handoff id: ${id}`, { handoffId: id }));
  }
  return ok(undefined);
}

// Second-line defense: even if validateHandoffId misses a pathological case on some
// platform, path.resolve normalization plus a prefix check catches anything that
// resolves outside the configured handoffs directory.
function resolveHandoffPath(handoffsDir: string, id: string): Result<string, FlowDefinitionError> {
  const rootResolved = resolve(handoffsDir);
  const fullResolved = resolve(handoffsDir, `${id}.json`);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (fullResolved !== rootResolved && !fullResolved.startsWith(rootPrefix)) {
    return err(
      new FlowDefinitionError('handoff path escapes store directory', {
        handoffId: id,
        resolved: fullResolved,
        root: rootResolved,
      }),
    );
  }
  return ok(fullResolved);
}

// Validates an iteration index. Must be a non-negative safe integer; rejects
// negatives, fractions, NaN, Infinity, and anything large enough to confuse
// the integer comparison the runner relies on.
function validateIteration(iter: number): Result<void, FlowDefinitionError> {
  if (typeof iter !== 'number' || !Number.isSafeInteger(iter) || iter < 0) {
    return err(
      new FlowDefinitionError(`invalid iteration index: ${String(iter)}`, {
        cause: { iter },
      }),
    );
  }
  return ok(undefined);
}

// Resolves an iteration-scoped handoff path
// (`<handoffsDir>/<loopStepId>/iter_<iter>/<name>.json`) and confirms the
// resolved path still lives under the store root. Each id segment must pass
// validateHandoffId; the iteration index must pass validateIteration.
function resolveIterationPath(
  handoffsDir: string,
  loopStepId: string,
  iter: number,
  name: string,
): Result<string, FlowDefinitionError> {
  const stepCheck = validateHandoffId(loopStepId);
  if (stepCheck.isErr()) return err(stepCheck.error);
  const nameCheck = validateHandoffId(name);
  if (nameCheck.isErr()) return err(nameCheck.error);
  const iterCheck = validateIteration(iter);
  if (iterCheck.isErr()) return err(iterCheck.error);

  const rootResolved = resolve(handoffsDir);
  const fullResolved = resolve(handoffsDir, loopStepId, `iter_${iter}`, `${name}.json`);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (!fullResolved.startsWith(rootPrefix)) {
    return err(
      new FlowDefinitionError('handoff path escapes store directory', {
        handoffId: `${loopStepId}/iter_${iter}/${name}`,
        resolved: fullResolved,
        root: rootResolved,
      }),
    );
  }
  return ok(fullResolved);
}

// Resolves the latest-pointer path for a loop step's named handoff
// (`<handoffsDir>/<loopStepId>/<name>.json`) and confirms it still lives
// under the store root. Each id segment is validated.
function resolveLatestPath(
  handoffsDir: string,
  loopStepId: string,
  name: string,
): Result<string, FlowDefinitionError> {
  const stepCheck = validateHandoffId(loopStepId);
  if (stepCheck.isErr()) return err(stepCheck.error);
  const nameCheck = validateHandoffId(name);
  if (nameCheck.isErr()) return err(nameCheck.error);

  const rootResolved = resolve(handoffsDir);
  const fullResolved = resolve(handoffsDir, loopStepId, `${name}.json`);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (!fullResolved.startsWith(rootPrefix)) {
    return err(
      new FlowDefinitionError('handoff path escapes store directory', {
        handoffId: `${loopStepId}/${name}`,
        resolved: fullResolved,
        root: rootResolved,
      }),
    );
  }
  return ok(fullResolved);
}

function errnoOf(cause: unknown): string | undefined {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Zod issue arrays stored in FlowDefinitionError.details.cause always have an
// object with at least a `code` string at each position. This guard narrows the
// retrieved unknown back to a shape the HandoffSchemaError constructor accepts.
function isZodIssueArray(value: unknown): value is z.core.$ZodIssue[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'object' && item !== null && 'code' in item)
  );
}

export type WriteError = HandoffSchemaError | HandoffWriteError | FlowDefinitionError;
type ReadError = HandoffNotFoundError | HandoffSchemaError | HandoffIoError | FlowDefinitionError;

export class HandoffStore {
  readonly #handoffsDir: string;
  // Serializes concurrent writes to the same id. Keyed by id; the stored
  // promise is the tail of the chain — each new writer appends to it and
  // replaces the entry. Final state is last-writer-wins with no torn files.
  readonly #writeLocks = new Map<string, Promise<Result<void, WriteError>>>();

  constructor(runDir: string) {
    this.#handoffsDir = join(runDir, 'handoffs');
  }

  /**
   * Persists a handoff value to `<runDir>/handoffs/<id>.json` via an atomic
   * rename. The id is validated against an allowlist and the resolved path
   * is checked to still live under the store directory; invalid ids return
   * a FlowDefinitionError without touching the filesystem.
   *
   * Concurrent calls for the same id are serialized through an in-process
   * mutex so each call only runs after the previous one settles. Readers
   * are not blocked; they may observe the pre-rename state, which is
   * atomic at the filesystem level. Cross-process serialization is out of
   * scope — the caller (typically the Orchestrator) is expected not to schedule
   * two writers for the same id across processes.
   *
   * Returns err with HandoffSchemaError on Zod validation failure,
   * HandoffWriteError on filesystem write failure, or FlowDefinitionError
   * on id validation failure.
   */
  write<T>(id: string, value: T, schema?: z.ZodType<T>): Promise<Result<void, WriteError>> {
    const previous = this.#writeLocks.get(id);
    const chained: Promise<Result<void, WriteError>> = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    ).then(() => this.#performWrite(id, value, schema));

    this.#writeLocks.set(id, chained);
    void chained.finally(() => {
      // Only clear the slot if nobody has chained onto us in the meantime;
      // otherwise we would drop the tail of the queue for later writers.
      if (this.#writeLocks.get(id) === chained) {
        this.#writeLocks.delete(id);
      }
    });

    return chained;
  }

  async #performWrite<T>(
    id: string,
    value: T,
    schema: z.ZodType<T> | undefined,
  ): Promise<Result<void, WriteError>> {
    const idCheck = validateHandoffId(id);
    if (idCheck.isErr()) return err(idCheck.error);

    const pathResult = resolveHandoffPath(this.#handoffsDir, id);
    if (pathResult.isErr()) return err(pathResult.error);

    if (schema !== undefined) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return err(
          new HandoffSchemaError(
            `handoff "${id}" failed schema validation`,
            id,
            parsed.error.issues,
          ),
        );
      }
    }

    const writeResult = await atomicWriteJson(pathResult.value, value);
    if (writeResult.isErr()) {
      return err(
        new HandoffWriteError(`failed to write handoff "${id}"`, id, {
          cause: writeResult.error,
          ...(writeResult.error.errno !== undefined ? { errno: writeResult.error.errno } : {}),
          path: writeResult.error.path,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Loads and optionally schema-validates a handoff value from
   * `<runDir>/handoffs/<id>.json`. The id is validated against the same
   * allowlist as write and the resolved path is checked to live under the
   * store directory.
   *
   * Returns err with FlowDefinitionError on id validation failure,
   * HandoffNotFoundError when the file does not exist, HandoffSchemaError
   * on Zod validation failure, or HandoffIoError on any other filesystem
   * or JSON parse error.
   *
   * When called without a schema the ok payload is raw unknown.
   * When called with a Zod schema the ok payload is the inferred type T and
   * schema-mismatch is surfaced as a distinct HandoffSchemaError.
   */
  async read(
    id: string,
  ): Promise<Result<unknown, HandoffNotFoundError | HandoffIoError | FlowDefinitionError>>;
  async read<T>(
    id: string,
    schema: z.ZodType<T>,
  ): Promise<
    Result<T, HandoffNotFoundError | HandoffSchemaError | HandoffIoError | FlowDefinitionError>
  >;
  async read<T>(id: string, schema?: z.ZodType<T>): Promise<Result<T | unknown, ReadError>> {
    const idCheck = validateHandoffId(id);
    if (idCheck.isErr()) return err(idCheck.error);

    const pathResult = resolveHandoffPath(this.#handoffsDir, id);
    if (pathResult.isErr()) return err(pathResult.error);

    let raw: string;
    try {
      raw = await readFile(pathResult.value, { encoding: 'utf8' });
    } catch (cause) {
      const errno = errnoOf(cause);
      if (errno === 'ENOENT') {
        return err(new HandoffNotFoundError(`handoff "${id}" not found`, id));
      }
      return err(
        new HandoffIoError(`failed to read handoff "${id}"`, id, {
          cause: messageOf(cause),
          ...(errno !== undefined ? { errno } : {}),
        }),
      );
    }

    if (schema !== undefined) {
      const result = parseWithSchema(raw, schema);
      if (result.isErr()) {
        const jsonErr = result.error;
        const rawIssues = jsonErr.details?.['cause'];
        const issues = isZodIssueArray(rawIssues) ? rawIssues : [];
        return err(new HandoffSchemaError(jsonErr.message, id, issues));
      }
      return ok(result.value);
    }

    const result = safeParse(raw);
    if (result.isErr()) {
      const jsonErr = result.error;
      return err(new HandoffIoError(jsonErr.message, id, { cause: jsonErr.details?.['cause'] }));
    }
    return ok(result.value);
  }

  async exists(id: string): Promise<boolean> {
    const idCheck = validateHandoffId(id);
    if (idCheck.isErr()) return false;
    const pathResult = resolveHandoffPath(this.#handoffsDir, id);
    if (pathResult.isErr()) return false;
    try {
      await stat(pathResult.value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lists handoff ids present on disk, stripped of the `.json` suffix and
   * sorted alphabetically. A missing handoffs directory is treated as a
   * fresh run and returns ok([]). Any other readdir failure (permissions,
   * not-a-directory, etc.) returns err(HandoffIoError) so callers can
   * distinguish "nothing written yet" from "cannot read the directory".
   */
  async list(): Promise<Result<string[], HandoffIoError>> {
    let entries: string[];
    try {
      entries = await readdir(this.#handoffsDir);
    } catch (cause) {
      const errno = errnoOf(cause);
      if (errno === 'ENOENT') {
        return ok([]);
      }
      return err(
        new HandoffIoError('failed to list handoffs directory', undefined, {
          cause: messageOf(cause),
          ...(errno !== undefined ? { errno } : {}),
          dir: this.#handoffsDir,
        }),
      );
    }

    const ids = entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    return ok(ids);
  }

  /**
   * Persists a handoff value at the iteration-scoped path
   * `<runDir>/handoffs/<loopStepId>/iter_<iter>/<name>.json` via an atomic
   * rename. The loopStepId and name segments are validated against the
   * standard handoff id allowlist; iter must be a non-negative safe integer.
   * The resolved path is verified to still live under the store root.
   *
   * Parent directories are created via `mkdir({ recursive: true })` inside
   * `atomicWriteJson` before the write begins, so callers do not need to
   * ensure the loop or iteration directory exists first.
   *
   * Returns err with HandoffSchemaError on Zod validation failure,
   * HandoffWriteError on filesystem write failure, or FlowDefinitionError
   * on segment or iteration validation failure.
   */
  async writeIteration<T>(
    loopStepId: string,
    iter: number,
    name: string,
    value: T,
    schema?: z.ZodType<T>,
  ): Promise<Result<void, WriteError>> {
    const pathResult = resolveIterationPath(this.#handoffsDir, loopStepId, iter, name);
    if (pathResult.isErr()) return err(pathResult.error);

    const handoffId = `${loopStepId}/iter_${iter}/${name}`;

    if (schema !== undefined) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return err(
          new HandoffSchemaError(
            `handoff "${handoffId}" failed schema validation`,
            handoffId,
            parsed.error.issues,
          ),
        );
      }
    }

    const writeResult = await atomicWriteJson(pathResult.value, value);
    if (writeResult.isErr()) {
      return err(
        new HandoffWriteError(`failed to write handoff "${handoffId}"`, handoffId, {
          cause: writeResult.error,
          ...(writeResult.error.errno !== undefined ? { errno: writeResult.error.errno } : {}),
          path: writeResult.error.path,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Loads and optionally schema-validates a handoff value from the
   * iteration-scoped path
   * `<runDir>/handoffs/<loopStepId>/iter_<iter>/<name>.json`. Segment and
   * iteration validation matches `writeIteration`.
   *
   * Returns err with FlowDefinitionError on segment or iteration validation
   * failure, HandoffNotFoundError when the file does not exist,
   * HandoffSchemaError on Zod validation failure, or HandoffIoError on any
   * other filesystem or JSON parse error.
   *
   * When called without a schema the ok payload is raw unknown.
   * When called with a Zod schema the ok payload is the inferred type T.
   */
  async readIteration(
    loopStepId: string,
    iter: number,
    name: string,
  ): Promise<Result<unknown, HandoffNotFoundError | HandoffIoError | FlowDefinitionError>>;
  async readIteration<T>(
    loopStepId: string,
    iter: number,
    name: string,
    schema: z.ZodType<T>,
  ): Promise<
    Result<T, HandoffNotFoundError | HandoffSchemaError | HandoffIoError | FlowDefinitionError>
  >;
  async readIteration<T>(
    loopStepId: string,
    iter: number,
    name: string,
    schema?: z.ZodType<T>,
  ): Promise<Result<T | unknown, ReadError>> {
    const pathResult = resolveIterationPath(this.#handoffsDir, loopStepId, iter, name);
    if (pathResult.isErr()) return err(pathResult.error);
    const handoffId = `${loopStepId}/iter_${iter}/${name}`;
    return this.#readJsonAt(pathResult.value, handoffId, schema);
  }

  /**
   * Reads the JSON at the iteration-scoped path
   * `<runDir>/handoffs/<loopStepId>/iter_<iter>/<name>.json` and writes it
   * atomically to the latest-pointer path
   * `<runDir>/handoffs/<loopStepId>/<name>.json`. This is a read-then-write
   * copy, not a filesystem symlink, so the latest pointer survives across
   * resumes that may load a different working directory.
   *
   * Returns err with FlowDefinitionError on segment or iteration validation
   * failure, HandoffWriteError when the source is missing or the destination
   * write fails, or HandoffSchemaError-shaped errors only when a caller
   * passes a schema (this method does not).
   */
  async promoteIteration(
    loopStepId: string,
    iter: number,
    name: string,
  ): Promise<Result<void, WriteError>> {
    const sourceResult = resolveIterationPath(this.#handoffsDir, loopStepId, iter, name);
    if (sourceResult.isErr()) return err(sourceResult.error);
    const targetResult = resolveLatestPath(this.#handoffsDir, loopStepId, name);
    if (targetResult.isErr()) return err(targetResult.error);

    const handoffId = `${loopStepId}/${name}`;

    let raw: string;
    try {
      raw = await readFile(sourceResult.value, { encoding: 'utf8' });
    } catch (cause) {
      const errno = errnoOf(cause);
      return err(
        new HandoffWriteError(
          `failed to read iteration handoff "${loopStepId}/iter_${iter}/${name}" for promotion`,
          handoffId,
          {
            cause: messageOf(cause),
            ...(errno !== undefined ? { errno } : {}),
            path: sourceResult.value,
          },
        ),
      );
    }

    const parsed = safeParse(raw);
    if (parsed.isErr()) {
      return err(
        new HandoffWriteError(
          `failed to parse iteration handoff "${loopStepId}/iter_${iter}/${name}" for promotion`,
          handoffId,
          {
            cause: parsed.error.details?.['cause'],
            path: sourceResult.value,
          },
        ),
      );
    }

    const writeResult = await atomicWriteJson(targetResult.value, parsed.value);
    if (writeResult.isErr()) {
      return err(
        new HandoffWriteError(`failed to write handoff "${handoffId}"`, handoffId, {
          cause: writeResult.error,
          ...(writeResult.error.errno !== undefined ? { errno: writeResult.error.errno } : {}),
          path: writeResult.error.path,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Loads and optionally schema-validates a handoff value from the
   * latest-pointer path `<runDir>/handoffs/<loopStepId>/<name>.json`. The
   * latest pointer is updated by `promoteIteration` after a loop iteration
   * decides its output is canonical; reading the latest pointer is the way
   * downstream steps observe the loop's final result.
   *
   * Returns err with FlowDefinitionError on segment validation failure,
   * HandoffNotFoundError when the file does not exist, HandoffSchemaError on
   * Zod validation failure, or HandoffIoError on any other filesystem or
   * JSON parse error.
   */
  async readLatest(
    loopStepId: string,
    name: string,
  ): Promise<Result<unknown, HandoffNotFoundError | HandoffIoError | FlowDefinitionError>>;
  async readLatest<T>(
    loopStepId: string,
    name: string,
    schema: z.ZodType<T>,
  ): Promise<
    Result<T, HandoffNotFoundError | HandoffSchemaError | HandoffIoError | FlowDefinitionError>
  >;
  async readLatest<T>(
    loopStepId: string,
    name: string,
    schema?: z.ZodType<T>,
  ): Promise<Result<T | unknown, ReadError>> {
    const pathResult = resolveLatestPath(this.#handoffsDir, loopStepId, name);
    if (pathResult.isErr()) return err(pathResult.error);
    const handoffId = `${loopStepId}/${name}`;
    return this.#readJsonAt(pathResult.value, handoffId, schema);
  }

  // Shared read helper used by readIteration and readLatest. Mirrors the body
  // of read() but takes a pre-resolved path and a synthetic handoff id used
  // only for error context.
  async #readJsonAt<T>(
    path: string,
    handoffId: string,
    schema: z.ZodType<T> | undefined,
  ): Promise<Result<T | unknown, ReadError>> {
    let raw: string;
    try {
      raw = await readFile(path, { encoding: 'utf8' });
    } catch (cause) {
      const errno = errnoOf(cause);
      if (errno === 'ENOENT') {
        return err(new HandoffNotFoundError(`handoff "${handoffId}" not found`, handoffId));
      }
      return err(
        new HandoffIoError(`failed to read handoff "${handoffId}"`, handoffId, {
          cause: messageOf(cause),
          ...(errno !== undefined ? { errno } : {}),
        }),
      );
    }

    if (schema !== undefined) {
      const result = parseWithSchema(raw, schema);
      if (result.isErr()) {
        const jsonErr = result.error;
        const rawIssues = jsonErr.details?.['cause'];
        const issues = isZodIssueArray(rawIssues) ? rawIssues : [];
        return err(new HandoffSchemaError(jsonErr.message, handoffId, issues));
      }
      return ok(result.value);
    }

    const result = safeParse(raw);
    if (result.isErr()) {
      const jsonErr = result.error;
      return err(
        new HandoffIoError(jsonErr.message, handoffId, { cause: jsonErr.details?.['cause'] }),
      );
    }
    return ok(result.value);
  }
}
