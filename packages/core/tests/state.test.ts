import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RaceStateMachine, loadState, verifyCompatibility } from '../src/state.js';
import {
  RaceStateCorruptError,
  RaceStateNotFoundError,
  RaceStateTransitionError,
  RaceStateVersionMismatchError,
} from '../src/errors.js';
import type { RaceState } from '../src/race/types.js';

const RACE_NAME = 'test-race';
const RACE_VERSION = '0.1.0';
const RUN_ID = 'run-1';

describe('RaceStateMachine — transitions + persistence', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-state-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function freshInit(runnerIds: string[] = ['a', 'b']): Promise<RaceStateMachine> {
    const sm = new RaceStateMachine(tmp, RACE_NAME, RACE_VERSION, RUN_ID);
    const r = await sm.init(runnerIds);
    expect(r.isOk()).toBe(true);
    return sm;
  }

  it('[STATE-001] init seeds steps as pending and persists state.json', async () => {
    const sm = await freshInit(['a', 'b']);
    const raw = await readFile(join(tmp, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as RaceState;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.raceName).toBe(RACE_NAME);
    expect(parsed.raceVersion).toBe(RACE_VERSION);
    expect(parsed.status).toBe('running');
    expect(parsed.runners.a.status).toBe('pending');
    expect(parsed.runners.a.attempts).toBe(0);
    expect(parsed.runners.b.status).toBe('pending');
    expect(typeof parsed.startedAt).toBe('string');
    expect(typeof parsed.updatedAt).toBe('string');
    void sm; // suppress unused
  });

  it('[STATE-002] startRunner transitions pending -> running and increments attempts to 1', async () => {
    const sm = await freshInit();
    const r = sm.startRunner('a');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.runners.a.status).toBe('running');
    expect(state.runners.a.attempts).toBe(1);
    expect(typeof state.runners.a.startedAt).toBe('string');
  });

  it('[STATE-003] double startRunner on running returns RaceStateTransitionError', async () => {
    const sm = await freshInit();
    sm.startRunner('a');
    const r = sm.startRunner('a');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(RaceStateTransitionError);
    expect(err.runnerId).toBe('a');
    expect(err.details?.from).toBe('running');
    expect(err.details?.attempted).toBe('start');
  });

  it('[STATE-004] completeRunner with artifacts records batons + artifacts arrays in insertion order', async () => {
    const sm = await freshInit();
    sm.startRunner('a');
    const artifacts = {
      inventory: '/runs/r1/batons/inventory.json',
      services: '/runs/r1/batons/services.json',
    };
    const r = sm.completeRunner('a', {
      batons: ['inventory', 'services'],
      artifacts: [artifacts.inventory, artifacts.services],
    });
    expect(r.isOk()).toBe(true);
    const runner = sm.getState().runners.a;
    expect(runner.status).toBe('succeeded');
    expect(runner.batons).toEqual(['inventory', 'services']);
    expect(runner.artifacts).toEqual([artifacts.inventory, artifacts.services]);
    expect(typeof runner.completedAt).toBe('string');
  });

  it('[STATE-005] failRunner does NOT escalate run-level status', async () => {
    const sm = await freshInit();
    sm.startRunner('a');
    const r = sm.failRunner('a', 'timed out');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.runners.a.status).toBe('failed');
    expect(state.runners.a.errorMessage).toBe('timed out');
    expect(state.status).toBe('running');
    expect(state.runners.b.status).toBe('pending');
  });

  it('[STATE-006] skipRunner works only from pending; running rejects with RaceStateTransitionError', async () => {
    const sm = await freshInit();
    const okCase = sm.skipRunner('a');
    expect(okCase.isOk()).toBe(true);
    expect(sm.getState().runners.a.status).toBe('skipped');

    sm.startRunner('b');
    const errCase = sm.skipRunner('b');
    expect(errCase.isErr()).toBe(true);
    const err = errCase._unsafeUnwrapErr();
    expect(err.details?.from).toBe('running');
    expect(err.details?.attempted).toBe('skip');
  });

  it('[STATE-007] resetRunner flips failed -> pending and preserves attempts', async () => {
    const sm = await freshInit();
    // attempt 1
    sm.startRunner('a');
    sm.failRunner('a', 'boom1');
    // reset to pending and run attempt 2 so attempts counter is 2
    sm.resetRunner('a');
    sm.startRunner('a');
    sm.failRunner('a', 'boom2');
    expect(sm.getState().runners.a.attempts).toBe(2);
    expect(sm.getState().runners.a.errorMessage).toBe('boom2');

    const r = sm.resetRunner('a');
    expect(r.isOk()).toBe(true);
    const runner = sm.getState().runners.a;
    expect(runner.status).toBe('pending');
    expect(runner.attempts).toBe(2);
    expect(runner.startedAt).toBeUndefined();
    expect(runner.completedAt).toBeUndefined();
    expect(runner.errorMessage).toBeUndefined();
    expect(runner.batons).toBeUndefined();
    expect(runner.artifacts).toBeUndefined();
  });

  it('[STATE-008] resetRunner on a succeeded step returns RaceStateTransitionError', async () => {
    const sm = await freshInit();
    sm.startRunner('a');
    sm.completeRunner('a');
    const r = sm.resetRunner('a');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err.details?.attempted).toBe('reset');
    expect(err.details?.from).toBe('succeeded');
  });

  it('[STATE-009] markRun(aborted) sweeps dangling running steps to failed', async () => {
    const sm = await freshInit(['a', 'b', 'c']);
    sm.startRunner('a');
    sm.completeRunner('a');
    sm.startRunner('b');
    const r = sm.markRun('aborted');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.status).toBe('aborted');
    expect(state.runners.a.status).toBe('succeeded');
    expect(state.runners.b.status).toBe('failed');
    expect(state.runners.b.errorMessage).toBe('run aborted');
    expect(typeof state.runners.b.completedAt).toBe('string');
    expect(state.runners.c.status).toBe('pending');
  });

  it('[STATE-010] markRun(succeeded) does NOT sweep running steps', async () => {
    const sm = await freshInit(['a']);
    sm.startRunner('a');
    const r = sm.markRun('succeeded');
    expect(r.isOk()).toBe(true);
    const state = sm.getState();
    expect(state.status).toBe('succeeded');
    expect(state.runners.a.status).toBe('running');
  });

  it('[STATE-011] save + load roundtrip preserves state shape', async () => {
    const sm = await freshInit(['a', 'b']);
    sm.startRunner('a');
    sm.completeRunner('a');
    sm.startRunner('b');
    const saveR = await sm.save();
    expect(saveR.isOk()).toBe(true);

    const loadR = await RaceStateMachine.load(tmp);
    expect(loadR.isOk()).toBe(true);
    const loaded = loadR._unsafeUnwrap();
    expect(loaded.runId).toBe(RUN_ID);
    expect(loaded.raceName).toBe(RACE_NAME);
    expect(loaded.raceVersion).toBe(RACE_VERSION);
    expect(loaded.runners.a.status).toBe('succeeded');
    expect(loaded.runners.b.status).toBe('running');
  });

  it('[STATE-012] loadState on missing file returns RaceStateNotFoundError (not generic IO)', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'relay-empty-'));
    try {
      const r = await loadState(emptyDir);
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceStateNotFoundError);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('[STATE-013] loadState on malformed JSON returns RaceStateCorruptError', async () => {
    await writeFile(join(tmp, 'state.json'), 'not valid json {', 'utf8');
    const r = await loadState(tmp);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceStateCorruptError);
    expect(typeof r._unsafeUnwrapErr().details?.reason).toBe('string');
  });

  it('[STATE-014] loadAndVerify returns RaceStateVersionMismatchError on raceName mismatch', async () => {
    const fixture: RaceState = {
      runId: 'r1',
      raceName: 'oldFlow',
      raceVersion: '1.0.0',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      input: null,
      runners: {},
    };
    await writeFile(join(tmp, 'state.json'), JSON.stringify(fixture), 'utf8');

    const r = await RaceStateMachine.loadAndVerify({
      runDir: tmp,
      raceName: 'newFlow',
      raceVersion: '1.0.0',
    });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(RaceStateVersionMismatchError);
    if (err instanceof RaceStateVersionMismatchError) {
      expect(err.expected.raceName).toBe('newFlow');
      expect(err.actual.raceName).toBe('oldFlow');
    }
    expect(err.message).toContain('oldFlow');
    expect(err.message).toContain('newFlow');
  });

  it('[STATE-015] loadAndVerify returns RaceStateVersionMismatchError on version bump', async () => {
    const fixture: RaceState = {
      runId: 'r1',
      raceName: 'codebase-discovery',
      raceVersion: '0.1.0',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      input: null,
      runners: {},
    };
    await writeFile(join(tmp, 'state.json'), JSON.stringify(fixture), 'utf8');

    const r = await RaceStateMachine.loadAndVerify({
      runDir: tmp,
      raceName: 'codebase-discovery',
      raceVersion: '1.0.0',
    });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(RaceStateVersionMismatchError);
    expect(err.message).toContain('0.1.0');
    expect(err.message).toContain('1.0.0');
  });
});

describe('verifyCompatibility', () => {
  it('returns ok when name + version match', () => {
    const state: RaceState = {
      runId: 'r',
      raceName: 'f',
      raceVersion: '1.0',
      status: 'running',
      startedAt: '',
      updatedAt: '',
      input: null,
      runners: {},
    };
    const r = verifyCompatibility(state, { raceName: 'f', raceVersion: '1.0' });
    expect(r.isOk()).toBe(true);
  });
});
