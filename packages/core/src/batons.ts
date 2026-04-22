import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import {
  RaceDefinitionError,
  BatonIoError,
  BatonNotFoundError,
  BatonSchemaError,
  BatonWriteError,
} from './errors.js';
import { atomicWriteJson } from './util/atomic-write.js';
import type { z } from './zod.js';
import { parseWithSchema, safeParse } from './util/json.js';

// Non-empty id that starts alphanumeric and may continue with alphanumerics, dot, underscore, dash.
// Rejects path separators, parent-dir segments, hidden-file leading dot, and any ASCII control chars.
const BATON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateBatonId(id: string): Result<void, RaceDefinitionError> {
  if (
    id.length === 0 ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('..') ||
    id.startsWith('.') ||
    hasControlChar(id) ||
    !BATON_ID_PATTERN.test(id)
  ) {
    return err(new RaceDefinitionError(`invalid baton id: ${id}`, { batonId: id }));
  }
  return ok(undefined);
}

// Second-line defense: even if validateBatonId misses a pathological case on some
// platform, path.resolve normalization plus a prefix check catches anything that
// resolves outside the configured batons directory.
function resolveBatonPath(
  batonsDir: string,
  id: string,
): Result<string, RaceDefinitionError> {
  const rootResolved = resolve(batonsDir);
  const fullResolved = resolve(batonsDir, `${id}.json`);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (fullResolved !== rootResolved && !fullResolved.startsWith(rootPrefix)) {
    return err(
      new RaceDefinitionError('baton path escapes store directory', {
        batonId: id,
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

// Zod issue arrays stored in RaceDefinitionError.details.cause always have an
// object with at least a `code` string at each position. This guard narrows the
// retrieved unknown back to a shape the BatonSchemaError constructor accepts.
function isZodIssueArray(value: unknown): value is z.core.$ZodIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'object' && item !== null && 'code' in item,
    )
  );
}

type WriteError = BatonSchemaError | BatonWriteError | RaceDefinitionError;
type ReadError = BatonNotFoundError | BatonSchemaError | BatonIoError | RaceDefinitionError;

export class BatonStore {
  readonly #batonsDir: string;
  // Serializes concurrent writes to the same id. Keyed by id; the stored
  // promise is the tail of the chain — each new writer appends to it and
  // replaces the entry. Final state is last-writer-wins with no torn files.
  readonly #writeLocks = new Map<string, Promise<Result<void, WriteError>>>();

  constructor(runDir: string) {
    this.#batonsDir = join(runDir, 'batons');
  }

  /**
   * Persists a baton value to `<runDir>/batons/<id>.json` via an atomic
   * rename. The id is validated against an allowlist and the resolved path
   * is checked to still live under the store directory; invalid ids return
   * a RaceDefinitionError without touching the filesystem.
   *
   * Concurrent calls for the same id are serialized through an in-process
   * mutex so each call only runs after the previous one settles. Readers
   * are not blocked; they may observe the pre-rename state, which is
   * atomic at the filesystem level. Cross-process serialization is out of
   * scope — the caller (typically the Runner) is expected not to schedule
   * two writers for the same id across processes.
   *
   * Returns err with BatonSchemaError on Zod validation failure,
   * BatonWriteError on filesystem write failure, or RaceDefinitionError
   * on id validation failure.
   */
  write<T>(
    id: string,
    value: T,
    schema?: z.ZodType<T>,
  ): Promise<Result<void, WriteError>> {
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
    const idCheck = validateBatonId(id);
    if (idCheck.isErr()) return err(idCheck.error);

    const pathResult = resolveBatonPath(this.#batonsDir, id);
    if (pathResult.isErr()) return err(pathResult.error);

    if (schema !== undefined) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return err(
          new BatonSchemaError(`baton "${id}" failed schema validation`, id, parsed.error.issues),
        );
      }
    }

    const writeResult = await atomicWriteJson(pathResult.value, value);
    if (writeResult.isErr()) {
      return err(
        new BatonWriteError(`failed to write baton "${id}"`, id, {
          cause: writeResult.error,
          errno: writeResult.error.errno,
          path: writeResult.error.path,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Loads and optionally schema-validates a baton value from
   * `<runDir>/batons/<id>.json`. The id is validated against the same
   * allowlist as write and the resolved path is checked to live under the
   * store directory.
   *
   * Returns err with RaceDefinitionError on id validation failure,
   * BatonNotFoundError when the file does not exist, BatonSchemaError
   * on Zod validation failure, or BatonIoError on any other filesystem
   * or JSON parse error.
   *
   * When called without a schema the ok payload is raw unknown.
   * When called with a Zod schema the ok payload is the inferred type T and
   * schema-mismatch is surfaced as a distinct BatonSchemaError.
   */
  async read(
    id: string,
  ): Promise<Result<unknown, BatonNotFoundError | BatonIoError | RaceDefinitionError>>;
  async read<T>(
    id: string,
    schema: z.ZodType<T>,
  ): Promise<Result<T, BatonNotFoundError | BatonSchemaError | BatonIoError | RaceDefinitionError>>;
  async read<T>(
    id: string,
    schema?: z.ZodType<T>,
  ): Promise<Result<T | unknown, ReadError>> {
    const idCheck = validateBatonId(id);
    if (idCheck.isErr()) return err(idCheck.error);

    const pathResult = resolveBatonPath(this.#batonsDir, id);
    if (pathResult.isErr()) return err(pathResult.error);

    let raw: string;
    try {
      raw = await readFile(pathResult.value, { encoding: 'utf8' });
    } catch (cause) {
      if (errnoOf(cause) === 'ENOENT') {
        return err(new BatonNotFoundError(`baton "${id}" not found`, id));
      }
      return err(
        new BatonIoError(`failed to read baton "${id}"`, id, {
          cause: messageOf(cause),
          errno: errnoOf(cause),
        }),
      );
    }

    if (schema !== undefined) {
      const result = parseWithSchema(raw, schema);
      if (result.isErr()) {
        const jsonErr = result.error;
        const rawIssues = jsonErr.details?.['cause'];
        const issues = isZodIssueArray(rawIssues) ? rawIssues : [];
        return err(new BatonSchemaError(jsonErr.message, id, issues));
      }
      return ok(result.value);
    }

    const result = safeParse(raw);
    if (result.isErr()) {
      const jsonErr = result.error;
      return err(
        new BatonIoError(jsonErr.message, id, { cause: jsonErr.details?.['cause'] }),
      );
    }
    return ok(result.value);
  }

  async exists(id: string): Promise<boolean> {
    const idCheck = validateBatonId(id);
    if (idCheck.isErr()) return false;
    const pathResult = resolveBatonPath(this.#batonsDir, id);
    if (pathResult.isErr()) return false;
    try {
      await stat(pathResult.value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lists baton ids present on disk, stripped of the `.json` suffix and
   * sorted alphabetically. A missing batons directory is treated as a
   * fresh run and returns ok([]). Any other readdir failure (permissions,
   * not-a-directory, etc.) returns err(BatonIoError) so callers can
   * distinguish "nothing written yet" from "cannot read the directory".
   */
  async list(): Promise<Result<string[], BatonIoError>> {
    let entries: string[];
    try {
      entries = await readdir(this.#batonsDir);
    } catch (cause) {
      if (errnoOf(cause) === 'ENOENT') {
        return ok([]);
      }
      return err(
        new BatonIoError('failed to list batons directory', undefined, {
          cause: messageOf(cause),
          errno: errnoOf(cause),
          dir: this.#batonsDir,
        }),
      );
    }

    const ids = entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    return ok(ids);
  }
}
