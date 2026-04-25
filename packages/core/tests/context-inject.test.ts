import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assemblePrompt, loadHandoffValues } from '../src/context-inject.js';
import { FlowDefinitionError, HandoffNotFoundError } from '../src/errors.js';
import { HandoffStore } from '../src/handoffs.js';

describe('assemblePrompt', () => {
  it('[CTX-001] wraps handoffs in <c name="id"> blocks in requested order', () => {
    const r = assemblePrompt({
      promptBody: 'body',
      handoffs: { alpha: { a: 1 }, beta: { b: 2 } },
      inputVars: {},
      stepVars: {},
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

  it('[CTX-002] variable precedence — stepVars > handoffs > inputVars', () => {
    const r = assemblePrompt({
      promptBody: '{{who}}',
      inputVars: { who: 'input' },
      handoffs: { who: 'handoff' },
      stepVars: { who: 'step' },
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    expect(out).toContain('step');
    expect(out).not.toContain('>input<');
  });

  it('[CTX-005] emits no <context> when handoffs is empty', () => {
    const r = assemblePrompt({
      promptBody: 'body',
      handoffs: {},
      inputVars: {},
      stepVars: {},
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    expect(out).not.toContain('<context');
    expect(out).toContain('body');
  });

  it('[CTX-006] malformed template returns err(FlowDefinitionError), does not throw', () => {
    const r = assemblePrompt({
      promptBody: '{{#each unterminated',
      handoffs: {},
      inputVars: {},
      stepVars: {},
    });
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(FlowDefinitionError);
  });

  it('[CTX-007] nested handoff properties render via Handlebars template variables', () => {
    const r = assemblePrompt({
      promptBody: 'Value is {{handoff1.x}} and label is {{handoff2.label}}',
      handoffs: { handoff1: { x: 42 }, handoff2: { label: 'hello' } },
      inputVars: {},
      stepVars: {},
    });
    expect(r.isOk()).toBe(true);
    const out = r._unsafeUnwrap();
    // Both template variables must be resolved — no unresolved {{ }} placeholders
    expect(out).toContain('42');
    expect(out).toContain('hello');
    expect(out).not.toMatch(/\{\{handoff[12]\.\w+\}\}/);
  });
});

describe('loadHandoffValues', () => {
  let tmp: string;
  let store: HandoffStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ctx-'));
    store = new HandoffStore(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[CTX-003] fails fast on the first missing handoff', async () => {
    await store.write('alpha', { a: 1 });
    const r = await loadHandoffValues(store, ['alpha', 'beta', 'gamma']);
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(HandoffNotFoundError);
    if (err instanceof HandoffNotFoundError) {
      expect(err.handoffId).toBe('beta');
    }
  });

  it('[CTX-004] ok result preserves ids in the requested order', async () => {
    await store.write('alpha', { a: 1 });
    await store.write('beta', { b: 2 });
    const r = await loadHandoffValues(store, ['beta', 'alpha']);
    expect(r.isOk()).toBe(true);
    expect(Object.keys(r._unsafeUnwrap())).toEqual(['beta', 'alpha']);
  });
});
