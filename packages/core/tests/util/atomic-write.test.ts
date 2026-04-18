import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Module-level mock harness: each test can install a per-call override by
// setting `failWriteFile` / `failRenameOnce`. When null, the real fs is used.
// vi.mock is hoisted above the imports of atomic-write.ts so the stub reaches it.
const failWriteFile = vi.hoisted(() => ({
  value: null as null | { code: string; message: string },
}));
const failRenameOnce = vi.hoisted(() => ({
  value: null as null | { code: string; message: string },
  consumed: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    async open(path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1]) {
      const handle = await actual.open(path, flags);
      if (failWriteFile.value !== null) {
        const failure = failWriteFile.value;
        return {
          ...handle,
          writeFile: () => Promise.reject(Object.assign(new Error(failure.message), { code: failure.code })),
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }
      return handle;
    },
    async rename(src: Parameters<typeof actual.rename>[0], dst: Parameters<typeof actual.rename>[1]) {
      if (failRenameOnce.value !== null && !failRenameOnce.consumed) {
        failRenameOnce.consumed = true;
        const f = failRenameOnce.value;
        throw Object.assign(new Error(f.message), { code: f.code });
      }
      return actual.rename(src, dst);
    },
  };
});

import { atomicWriteJson, atomicWriteText } from '../../src/util/atomic-write.js';
import { AtomicWriteError } from '../../src/errors.js';

describe('atomicWriteJson / atomicWriteText', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-aw-'));
    failWriteFile.value = null;
    failRenameOnce.value = null;
    failRenameOnce.consumed = false;
  });

  afterEach(async () => {
    failWriteFile.value = null;
    failRenameOnce.value = null;
    failRenameOnce.consumed = false;
    await rm(tmp, { recursive: true, force: true });
  });

  it('[ATOMIC-001] creates parent directories when they do not exist', async () => {
    const path = join(tmp, 'deep', 'nested', 'file.json');
    const r = await atomicWriteJson(path, { x: 1 });
    expect(r.isOk()).toBe(true);
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ x: 1 });
  });

  it('[ATOMIC-002] after settle, only the target file exists (no .tmp-* leftovers)', async () => {
    const path = join(tmp, 'file.json');
    const r = await atomicWriteJson(path, { x: 2 });
    expect(r.isOk()).toBe(true);
    const entries = await readdir(tmp);
    expect(entries).toEqual(['file.json']);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ x: 2 });
  });

  it('[ATOMIC-003] previous file intact when writeFile rejects; no temp leftover', async () => {
    const path = join(tmp, 'file.json');
    await writeFile(path, JSON.stringify({ good: true }), 'utf8');

    failWriteFile.value = { code: 'EIO', message: 'EIO' };
    const r = await atomicWriteJson(path, { bad: true });

    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(AtomicWriteError);
    const stillThere = await readFile(path, 'utf8');
    expect(JSON.parse(stillThere)).toEqual({ good: true });
    const entries = await readdir(tmp);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('[ATOMIC-004] EXDEV fallback: copy+unlink completes the write', async () => {
    const path = join(tmp, 'file.json');
    failRenameOnce.value = { code: 'EXDEV', message: 'cross-device link' };

    const r = await atomicWriteJson(path, { x: 1 });

    expect(r.isOk()).toBe(true);
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ x: 1 });
    const entries = await readdir(tmp);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('[ATOMIC-005] terminal ENOSPC surfaces AtomicWriteError.errno', async () => {
    const path = join(tmp, 'file.json');
    failRenameOnce.value = { code: 'ENOSPC', message: 'no space left on device' };
    // Also make the EXDEV fallback unavailable by keeping only one failing call:
    // with the mock consuming after first call, the second rename would succeed.
    // But ENOSPC does not trigger EXDEV fallback — it re-throws. So the
    // atomic-write returns err on the first rename attempt.

    const r = await atomicWriteText(path, 'payload');

    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(AtomicWriteError);
    expect(err.errno).toBe('ENOSPC');
    expect(err.path).toContain('file.json');
  });
});
