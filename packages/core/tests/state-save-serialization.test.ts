import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RaceStateMachine } from '../src/state.js';
import type { RaceState } from '../src/race/types.js';

const RACE_NAME = 'serialize-race';
const RACE_VERSION = '0.1.0';
const RUN_ID = 'run-serialize';

describe('RaceStateMachine — save() serialization', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-state-serialize-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[STATE-SERIALIZE-001] 20 concurrent save() calls all resolve ok and the final on-disk snapshot equals final in-memory state', async () => {
    const runnerIds = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sm = new RaceStateMachine(tmp, RACE_NAME, RACE_VERSION, RUN_ID);
    const initR = await sm.init(runnerIds);
    expect(initR.isOk()).toBe(true);

    const saves: Promise<unknown>[] = [];
    for (const id of runnerIds) {
      sm.startRunner(id);
      sm.completeRunner(id);
      saves.push(sm.save());
    }

    const results = await Promise.all(saves);
    for (const r of results) {
      const res = r as { isOk: () => boolean };
      expect(res.isOk()).toBe(true);
    }

    const raw = await readFile(join(tmp, 'state.json'), 'utf8');
    const onDisk = JSON.parse(raw) as RaceState;
    const inMemory = sm.getState();
    expect(onDisk).toEqual(inMemory);
    for (const id of runnerIds) {
      expect(onDisk.runners[id]?.status).toBe('succeeded');
    }
  });

  it('[STATE-SERIALIZE-002] every intermediate snapshot read between concurrent saves is a monotonic prefix of in-memory history (succeeded count never goes backwards)', async () => {
    const runnerIds = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sm = new RaceStateMachine(tmp, RACE_NAME, RACE_VERSION, RUN_ID);
    const initR = await sm.init(runnerIds);
    expect(initR.isOk()).toBe(true);

    const stateFile = join(tmp, 'state.json');

    // Submit all 20 saves while mutating between each. Without serialization,
    // a later save could land before an earlier one and the on-disk file
    // would shrink (succeededCount would go down between adjacent reads).
    const saves: Promise<unknown>[] = [];
    for (const id of runnerIds) {
      sm.startRunner(id);
      sm.completeRunner(id);
      saves.push(sm.save());
    }

    // Read the on-disk file as each save settles. With strict serialization
    // each observed snapshot is at least as far along as the previous one.
    const observedSucceededCounts: number[] = [];
    for (let i = 0; i < saves.length; i += 1) {
      await saves[i];
      const raw = await readFile(stateFile, 'utf8');
      const snap = JSON.parse(raw) as RaceState;
      const succeeded = Object.values(snap.runners).filter(
        (s) => s.status === 'succeeded',
      ).length;
      observedSucceededCounts.push(succeeded);
    }

    expect(observedSucceededCounts.length).toBe(runnerIds.length);

    // Monotonic non-decreasing across all observations.
    for (let i = 1; i < observedSucceededCounts.length; i += 1) {
      expect(observedSucceededCounts[i]!).toBeGreaterThanOrEqual(
        observedSucceededCounts[i - 1]!,
      );
    }

    // Each observed value is in the valid range [1, 20] — every save was
    // submitted after at least one completion, and the final write must
    // include every succeeded runner.
    for (const count of observedSucceededCounts) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(runnerIds.length);
    }
    expect(observedSucceededCounts.at(-1)).toBe(runnerIds.length);

    // Final on-disk snapshot equals the final in-memory state.
    const finalRaw = await readFile(stateFile, 'utf8');
    const finalOnDisk = JSON.parse(finalRaw) as RaceState;
    expect(finalOnDisk).toEqual(sm.getState());
  });

  it('[STATE-SERIALIZE-003] a failing save does not break the chain — a subsequent save still runs', async () => {
    // Construct a RaceStateMachine pointed at an invalid path so every save
    // fails. The point is to verify the queue keeps draining after a
    // failure rather than hanging forever on the rejected tail.
    const sm = new RaceStateMachine(
      join(tmp, 'definitely-not-a-dir.txt', 'nested'),
      RACE_NAME,
      RACE_VERSION,
      RUN_ID,
    );
    // Seed in-memory state without going through init() — init() calls
    // save() internally, which would also fail and is not what we want
    // to assert here.
    sm.hydrate({
      runId: RUN_ID,
      raceName: RACE_NAME,
      raceVersion: RACE_VERSION,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input: undefined,
      runners: {},
    });

    // Make the first path invalid by writing a file at the parent path
    // before save runs — atomicWriteJson's mkdir(dirname, recursive) will
    // fail because the parent already exists as a regular file.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmp, 'definitely-not-a-dir.txt'), 'blocker');

    const first = sm.save();
    const second = sm.save();

    const r1 = (await first) as { isErr: () => boolean };
    const r2 = (await second) as { isErr: () => boolean };
    // Both attempts settle — neither hangs the queue. Both fail because the
    // path is invalid; the load-bearing assertion is that the second call
    // ran at all (a broken chain would leave it pending forever).
    expect(r1.isErr()).toBe(true);
    expect(r2.isErr()).toBe(true);
  });
});
