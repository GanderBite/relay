import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ResultAsync } from 'neverthrow';

const toErr = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export function atomicWriteJson(path: string, value: unknown): ResultAsync<void, Error> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  return atomicWriteText(path, data);
}

export function atomicWriteText(path: string, data: string): ResultAsync<void, Error> {
  const tempPath = `${path}.tmp-${randomUUID()}`;

  const writeAndRename = ResultAsync.fromPromise(
    mkdir(dirname(path), { recursive: true }),
    toErr,
  )
    .andThen(() => ResultAsync.fromPromise(writeFile(tempPath, data, { encoding: 'utf8' }), toErr))
    .andThen(() => ResultAsync.fromPromise(rename(tempPath, path), toErr));

  return writeAndRename.orElse((originalError) =>
    ResultAsync.fromPromise(rm(tempPath, { force: true }), () => originalError)
      .andThen(() => ResultAsync.fromSafePromise<void>(Promise.reject(originalError)))
      .orElse(() => ResultAsync.fromSafePromise<void>(Promise.reject(originalError))),
  );
}
