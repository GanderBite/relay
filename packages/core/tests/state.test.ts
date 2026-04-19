import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateMachine, loadState, verifyCompatibility } from '../src/state.js';
import {
  StateCorruptError,
  StateNotFoundError,
  StateTransitionError,
  StateVersionMismatchError,
} from '../src/errors.js';
import type { RunState } from '../src/flow/types.js';

const FLOW_NAME = 'test-flow';
const FLOW_VERSION = '0.1.0';
const RUN_ID = 'run-1';

describe('StateMachine — transitions + persistence', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-state-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function freshInit(stepIds: string[] = ['a', 'b']): Promise<StateMachine> {
    const sm = new StateMachine(tmp, FLOW_NAME, FLOW_VERSION, RUN_ID);
    const r = await sm.init(stepIds);
    expect(r.isOk()).toBe(true);
    return sm;
  }

  it('[STATE-001] init seeds steps as pending and persists state.json', async () => {
    const sm = await freshInit(['a', 'b']);
    const raw = await readFile(join(tmp, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as RunState;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.flowName).toBe(FLOW_NAME);
    expect(parsed.flowVersion).toBe(FLOW_VERSION);
    expect(parsed.status).toBe('running');
    expect(parsed.steps.a.status).toBe('pending');
    expect(parsed.steps.a.attempts).toBe(0);
    expect(parsed.steps.b.status).toBe('pending');
    expect(typeof parsed.startedAt).toBe('string');
    expect(typeof parsed.updatedAt).toBe('string');
    void sm; // suppress unused
  });

  it('[STATE-002] startStep transitions pending -> running and increments attempts to 1', async () => {
    const sm = await freshInit();
    const r = sm.startStep('a');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.steps.a.status).toBe('running');
    expect(state.steps.a.attempts).toBe(1);
    expect(typeof state.steps.a.startedAt).toBe('string');
  });

  it('[STATE-003] double startStep on running returns StateTransitionError', async () => {
    const sm = await freshInit();
    sm.startStep('a');
    const r = sm.startStep('a');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(StateTransitionError);
    expect(err.stepId).toBe('a');
    expect(err.details?.from).toBe('running');
    expect(err.details?.attempted).toBe('start');
  });

  it('[STATE-004] completeStep with artifacts records handoffs + artifacts arrays in insertion order', async () => {
    const sm = await freshInit();
    sm.startStep('a');
    const artifacts = {
      inventory: '/runs/r1/handoffs/inventory.json',
      services: '/runs/r1/handoffs/services.json',
    };
    const r = sm.completeStep('a', {
      handoffs: ['inventory', 'services'],
      artifacts: [artifacts.inventory, artifacts.services],
    });
    expect(r.isOk()).toBe(true);
    const step = sm.getState().steps.a;
    expect(step.status).toBe('succeeded');
    expect(step.handoffs).toEqual(['inventory', 'services']);
    expect(step.artifacts).toEqual([artifacts.inventory, artifacts.services]);
    expect(typeof step.completedAt).toBe('string');
  });

  it('[STATE-005] failStep does NOT escalate run-level status', async () => {
    const sm = await freshInit();
    sm.startStep('a');
    const r = sm.failStep('a', 'timed out');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.steps.a.status).toBe('failed');
    expect(state.steps.a.errorMessage).toBe('timed out');
    expect(state.status).toBe('running');
    expect(state.steps.b.status).toBe('pending');
  });

  it('[STATE-006] skipStep works only from pending; running rejects with StateTransitionError', async () => {
    const sm = await freshInit();
    const okCase = sm.skipStep('a');
    expect(okCase.isOk()).toBe(true);
    expect(sm.getState().steps.a.status).toBe('skipped');

    sm.startStep('b');
    const errCase = sm.skipStep('b');
    expect(errCase.isErr()).toBe(true);
    const err = errCase._unsafeUnwrapErr();
    expect(err.details?.from).toBe('running');
    expect(err.details?.attempted).toBe('skip');
  });

  it('[STATE-007] resetStep flips failed -> pending and preserves attempts', async () => {
    const sm = await freshInit();
    // attempt 1
    sm.startStep('a');
    sm.failStep('a', 'boom1');
    // reset to pending and run attempt 2 so attempts counter is 2
    sm.resetStep('a');
    sm.startStep('a');
    sm.failStep('a', 'boom2');
    expect(sm.getState().steps.a.attempts).toBe(2);
    expect(sm.getState().steps.a.errorMessage).toBe('boom2');

    const r = sm.resetStep('a');
    expect(r.isOk()).toBe(true);
    const step = sm.getState().steps.a;
    expect(step.status).toBe('pending');
    expect(step.attempts).toBe(2);
    expect(step.startedAt).toBeUndefined();
    expect(step.completedAt).toBeUndefined();
    expect(step.errorMessage).toBeUndefined();
    expect(step.handoffs).toBeUndefined();
    expect(step.artifacts).toBeUndefined();
  });

  it('[STATE-008] resetStep on a succeeded step returns StateTransitionError', async () => {
    const sm = await freshInit();
    sm.startStep('a');
    sm.completeStep('a');
    const r = sm.resetStep('a');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err.details?.attempted).toBe('reset');
    expect(err.details?.from).toBe('succeeded');
  });

  it('[STATE-009] markRun(aborted) sweeps dangling running steps to failed', async () => {
    const sm = await freshInit(['a', 'b', 'c']);
    sm.startStep('a');
    sm.completeStep('a');
    sm.startStep('b');
    const r = sm.markRun('aborted');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.status).toBe('aborted');
    expect(state.steps.a.status).toBe('succeeded');
    expect(state.steps.b.status).toBe('failed');
    expect(state.steps.b.errorMessage).toBe('run aborted');
    expect(typeof state.steps.b.completedAt).toBe('string');
    expect(state.steps.c.status).toBe('pending');
  });

  it('[STATE-010] markRun(succeeded) does NOT sweep running steps', async () => {
    const sm = await freshInit(['a']);
    sm.startStep('a');
    const r = sm.markRun('succeeded');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.status).toBe('succeeded');
    expect(state.steps.a.status).toBe('running');
  });

  it('[STATE-011] save + load roundtrip preserves state shape', async () => {
    const sm = await freshInit(['a', 'b']);
    sm.startStep('a');
    sm.completeStep('a');
    sm.startStep('b');
    const saveR = await sm.save();
    expect(saveR.isOk()).toBe(true);

    const loadR = await StateMachine.load(tmp);
    expect(loadR.isOk()).toBe(true);
    const loaded = loadR._unsafeUnwrap();
    expect(loaded.runId).toBe(RUN_ID);
    expect(loaded.flowName).toBe(FLOW_NAME);
    expect(loaded.flowVersion).toBe(FLOW_VERSION);
    expect(loaded.steps.a.status).toBe('succeeded');
    expect(loaded.steps.b.status).toBe('running');
  });

  it('[STATE-012] loadState on missing file returns StateNotFoundError (not generic IO)', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'relay-empty-'));
    try {
      const r = await loadState(emptyDir);
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr()).toBeInstanceOf(StateNotFoundError);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('[STATE-013] loadState on malformed JSON returns StateCorruptError', async () => {
    await writeFile(join(tmp, 'state.json'), 'not valid json {', 'utf8');
    const r = await loadState(tmp);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(StateCorruptError);
    expect(typeof r._unsafeUnwrapErr().details?.reason).toBe('string');
  });

  it('[STATE-014] loadAndVerify returns StateVersionMismatchError on flowName mismatch', async () => {
    const fixture: RunState = {
      runId: 'r1',
      flowName: 'oldFlow',
      flowVersion: '1.0.0',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      input: null,
      steps: {},
    };
    await writeFile(join(tmp, 'state.json'), JSON.stringify(fixture), 'utf8');

    const r = await StateMachine.loadAndVerify({
      runDir: tmp,
      flowName: 'newFlow',
      flowVersion: '1.0.0',
    });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(StateVersionMismatchError);
    if (err instanceof StateVersionMismatchError) {
      expect(err.expected.flowName).toBe('newFlow');
      expect(err.actual.flowName).toBe('oldFlow');
    }
    expect(err.message).toContain('oldFlow');
    expect(err.message).toContain('newFlow');
  });

  it('[STATE-015] loadAndVerify returns StateVersionMismatchError on version bump', async () => {
    const fixture: RunState = {
      runId: 'r1',
      flowName: 'codebase-discovery',
      flowVersion: '0.1.0',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      input: null,
      steps: {},
    };
    await writeFile(join(tmp, 'state.json'), JSON.stringify(fixture), 'utf8');

    const r = await StateMachine.loadAndVerify({
      runDir: tmp,
      flowName: 'codebase-discovery',
      flowVersion: '1.0.0',
    });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(StateVersionMismatchError);
    expect(err.message).toContain('0.1.0');
    expect(err.message).toContain('1.0.0');
  });
});

describe('verifyCompatibility', () => {
  it('returns ok when name + version match', () => {
    const state: RunState = {
      runId: 'r',
      flowName: 'f',
      flowVersion: '1.0',
      status: 'running',
      startedAt: '',
      updatedAt: '',
      input: null,
      steps: {},
    };
    const r = verifyCompatibility(state, { flowName: 'f', flowVersion: '1.0' });
    expect(r.isOk()).toBe(true);
  });
});
