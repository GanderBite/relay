import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BatonStore } from '../src/batons.js';
import {
  RaceDefinitionError,
  BatonIoError,
  BatonNotFoundError,
  BatonSchemaError,
} from '../src/errors.js';
import { z } from '../src/zod.js';

describe('BatonStore', () => {
  let tmp: string;
  let store: BatonStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ho-'));
    store = new BatonStore(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function batonsDirContents(): Promise<string[]> {
    try {
      return (await readdir(join(tmp, 'batons'))).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  it('[HANDOFF-001] write + read round-trip preserves value shape', async () => {
    const value = { packages: [{ name: 'x', language: 'ts' }] };
    const w = await store.write('inventory', value);
    expect(w.isOk()).toBe(true);
    const r = await store.read('inventory');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual(value);
    const path = join(tmp, 'batons', 'inventory.json');
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual(value);
  });

  it('[HANDOFF-002] path traversal via ".." in handoff id is rejected', async () => {
    const r = await store.write('../../etc/passwd', { x: 1 });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(RaceDefinitionError);
    expect(err.message).toContain('invalid baton id');
    expect(await batonsDirContents()).toEqual([]);
  });

  it('[HANDOFF-003] handoff id with slashes is rejected', async () => {
    for (const bad of ['a/b', 'a\\b', 'foo/']) {
      const r = await store.write(bad, {});
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceDefinitionError);
      expect(r._unsafeUnwrapErr().message).toContain('invalid baton id');
    }
    expect(await batonsDirContents()).toEqual([]);
  });

  it('[HANDOFF-004] handoff id starting with dot is rejected', async () => {
    const r = await store.write('.hidden', {});
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceDefinitionError);
    expect(r._unsafeUnwrapErr().message).toContain('invalid baton id');
  });

  it('[HANDOFF-005] handoff id with control chars is rejected', async () => {
    for (const ch of ['\x00', '\x1f', '\x7f']) {
      const r = await store.write(`x${ch}y`, {});
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceDefinitionError);
    }
  });

  it('[HANDOFF-006] empty handoff id is rejected', async () => {
    const r = await store.write('', {});
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceDefinitionError);
  });

  it('[HANDOFF-007] schema validation on write returns BatonSchemaError and writes no file', async () => {
    const schema = z.object({ name: z.string() });
    const r = await store.write('x', { name: 123 } as unknown as { name: string }, schema);
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(BatonSchemaError);
    if (err instanceof BatonSchemaError) {
      expect(err.batonId).toBe('x');
      expect(err.issues.length).toBeGreaterThan(0);
      expect(typeof err.issues[0].code).toBe('string');
    }
    expect(await batonsDirContents()).toEqual([]);
  });

  it('[HANDOFF-008] read with schema returns typed value on match', async () => {
    await mkdir(join(tmp, 'batons'), { recursive: true });
    await writeFile(
      join(tmp, 'batons', 'x.json'),
      JSON.stringify({ name: 'alice' }),
      'utf8',
    );
    const schema = z.object({ name: z.string() });
    const r = await store.read('x', schema);
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual({ name: 'alice' });
  });

  it('[HANDOFF-009] read on missing handoff returns BatonNotFoundError', async () => {
    const r = await store.read('never-written');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(BatonNotFoundError);
    expect(err).not.toBeInstanceOf(BatonIoError);
  });

  it('[HANDOFF-010] concurrent writes to same id serialize (no torn file)', async () => {
    const N = 10;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(store.write('x', { n: i }));
    }
    const results = await Promise.all(promises);
    for (const r of results) expect(r.isOk()).toBe(true);

    const raw = await readFile(join(tmp, 'batons', 'x.json'), 'utf8');
    const parsed = JSON.parse(raw) as { n: number };
    expect(typeof parsed.n).toBe('number');
    expect(parsed.n).toBeGreaterThanOrEqual(0);
    expect(parsed.n).toBeLessThan(N);
  });

  it('[HANDOFF-011] concurrent writes to different ids both succeed and produce independent files', async () => {
    const [a, b] = await Promise.all([
      store.write('a', { v: 'alpha' }),
      store.write('b', { v: 'beta' }),
    ]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    const ra = JSON.parse(await readFile(join(tmp, 'batons', 'a.json'), 'utf8'));
    const rb = JSON.parse(await readFile(join(tmp, 'batons', 'b.json'), 'utf8'));
    expect(ra).toEqual({ v: 'alpha' });
    expect(rb).toEqual({ v: 'beta' });
  });

  it('[HANDOFF-012] list returns sorted ids; missing dir treated as empty list', async () => {
    const emptyR = await store.list();
    expect(emptyR.isOk()).toBe(true);
    expect(emptyR._unsafeUnwrap()).toEqual([]);

    await mkdir(join(tmp, 'batons'), { recursive: true });
    await writeFile(join(tmp, 'batons', 'charlie.json'), '{}', 'utf8');
    await writeFile(join(tmp, 'batons', 'alpha.json'), '{}', 'utf8');
    await writeFile(join(tmp, 'batons', 'bravo.json'), '{}', 'utf8');
    await writeFile(join(tmp, 'batons', 'readme.md'), 'not json', 'utf8');

    const r = await store.list();
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual(['alpha', 'bravo', 'charlie']);
  });
});
