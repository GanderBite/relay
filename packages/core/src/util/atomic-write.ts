import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write `value` to `path` as pretty-printed JSON (2-space indent, trailing
 * newline) using the temp-file-and-rename pattern. The rename is atomic on
 * POSIX when source and destination are on the same filesystem, so readers
 * always see either the previous complete file or the new one — never a
 * partial write.
 *
 * Parent directories are created with mkdir({recursive:true}) before the
 * temp file is written. On any error after the temp file is created it is
 * removed (best-effort) before the error is rethrown.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteText(path, data);
}

/**
 * Write `data` (UTF-8 string) to `path` using the temp-file-and-rename
 * pattern. Temp-file plus rename keeps concurrent readers from seeing a torn
 * write; rename is atomic on POSIX when source and destination share the same
 * filesystem. See `atomicWriteJson` for full behaviour notes.
 */
export async function atomicWriteText(path: string, data: string): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(tempPath, data, { encoding: 'utf8' });
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}
