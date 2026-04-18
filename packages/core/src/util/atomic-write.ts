import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errAsync, ResultAsync } from 'neverthrow';

import { AtomicWriteError } from '../errors.js';

/**
 * Extracts the Node errno string (e.g. 'EXDEV', 'EACCES') from an unknown
 * value. Returns undefined when the value is not an Error with a string
 * `code` property. Narrows via type guards only — no `as` casts.
 */
function errnoOf(value: unknown): string | undefined {
  if (value instanceof Error && 'code' in value && typeof value.code === 'string') {
    return value.code;
  }
  return undefined;
}

/**
 * Open the temp file, write the payload, and fsync the file descriptor before
 * closing. The fsync ensures bytes are on stable storage before the caller
 * attempts the rename — without it, a power-loss between writeFile resolving
 * and rename landing can leave a zero-byte or torn file at the final path.
 */
async function writeAndSync(tempPath: string, text: string): Promise<void> {
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Rename the temp file onto the final path. Falls back to copy + unlink when
 * the rename crosses filesystem boundaries (EXDEV) — this loses same-syscall
 * atomicity but keeps the pipeline recoverable when runs live on a mounted
 * overlay or a symlinked directory that resolves to a different device.
 * All other errno values re-throw so the ResultAsync.fromPromise boundary
 * converts them into an Err branch.
 */
async function renameOrCopy(tempPath: string, finalPath: string): Promise<void> {
  try {
    await rename(tempPath, finalPath);
  } catch (caught) {
    if (errnoOf(caught) === 'EXDEV') {
      await copyFile(tempPath, finalPath);
      await unlink(tempPath);
      return;
    }
    throw caught;
  }
}

export function atomicWriteJson(
  path: string,
  value: unknown,
): ResultAsync<void, AtomicWriteError> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  return atomicWriteText(path, data);
}

export function atomicWriteText(
  path: string,
  data: string,
): ResultAsync<void, AtomicWriteError> {
  const tempPath = `${path}.tmp-${randomUUID()}`;

  const toAtomicWriteError = (caught: unknown): AtomicWriteError => {
    const message = caught instanceof Error ? caught.message : String(caught);
    const errno = errnoOf(caught);
    return new AtomicWriteError(`atomic write failed: ${message}`, path, errno, {
      cause: message,
    });
  };

  const writeAndRename = ResultAsync.fromPromise(
    mkdir(dirname(path), { recursive: true }),
    toAtomicWriteError,
  )
    .andThen(() => ResultAsync.fromPromise(writeAndSync(tempPath, data), toAtomicWriteError))
    .andThen(() => ResultAsync.fromPromise(renameOrCopy(tempPath, path), toAtomicWriteError));

  return writeAndRename.orElse((originalError) =>
    ResultAsync.fromPromise(rm(tempPath, { force: true }), () => originalError).andThen(() =>
      errAsync(originalError),
    ),
  );
}
