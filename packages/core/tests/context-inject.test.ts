import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assemblePrompt, loadBatonValues } from '../src/context-inject.js';
import { BatonStore } from '../src/batons.js';
import { RaceDefinitionError, BatonNotFoundError } from '../src/errors.js';

describe('assemblePrompt', () => {
  it('[CTX-001] wraps handoffs in <c name="id"> blocks in requested order', () => {
    const r = assemblePrompt({
      promptBody: 'body',
      batons: { alpha: { a: 1 }, beta: { b: 2 } },
      inputVars: {},
      runnerVars: {},
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    const alphaIdx = out.indexOf('<c name="alpha">');
    const betaIdx = out.indexOf('<c name="beta">');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(out).toContain('<prompt>');
    expect(out).toContain('body');
  });

  it('[CTX-002] variable precedence — runnerVars > handoffs > inputVars', () => {
    const r = assemblePrompt({
      promptBody: '{{who}}',
      inputVars: { who: 'input' },
      batons: { who: 'baton' },
      runnerVars: { who: 'step' },
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    expect(out).toContain('step');
    expect(out).not.toContain('>input<');
  });

  it('[CTX-005] emits no <context> when handoffs is empty', () => {
    const r = assemblePrompt({
      promptBody: 'body',
      batons: {},
      inputVars: {},
      runnerVars: {},
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    expect(out).not.toContain('<context');
    expect(out).toContain('body');
  });

  it('[CTX-006] malformed template returns err(RaceDefinitionError), does not throw', () => {
    const r = assemblePrompt({
      promptBody: '{{#each unterminated',
      batons: {},
      inputVars: {},
      runnerVars: {},
    });
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceDefinitionError);
  });
});

describe('loadBatonValues', () => {
  let tmp: string;
  let store: BatonStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ctx-'));
    store = new BatonStore(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[CTX-003] fails fast on the first missing handoff', async () => {
    await store.write('alpha', { a: 1 });
    const r = await loadBatonValues(store, ['alpha', 'beta', 'gamma']);
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(BatonNotFoundError);
    if (err instanceof BatonNotFoundError) {
      expect(err.batonId).toBe('beta');
    }
  });

  it('[CTX-004] ok result preserves ids in the requested order', async () => {
    await store.write('alpha', { a: 1 });
    await store.write('beta', { b: 2 });
    const r = await loadBatonValues(store, ['beta', 'alpha']);
    expect(r.isOk()).toBe(true);
    expect(Object.keys(r._unsafeUnwrap())).toEqual(['beta', 'alpha']);
  });
});
