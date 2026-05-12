import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type LiveStatePartial, writeLiveState } from '../../src/orchestrator/live-state.js';

describe('writeLiveState — iter/maxIter/branchCount fields', () => {
  let tmp: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    tmp = await mkdtemp(join(tmpdir(), 'relay-live-fields-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[LIVE-FIELDS-001] LiveStatePartial type accepts iter and maxIter', () => {
    const partial: LiveStatePartial = {
      status: 'running',
      attempt: 1,
      startedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      iter: 3,
      maxIter: 10,
    };
    expect(partial.iter).toBe(3);
    expect(partial.maxIter).toBe(10);
  });

  it('[LIVE-FIELDS-002] LiveStatePartial type accepts branchCount', () => {
    const partial: LiveStatePartial = {
      status: 'running',
      attempt: 1,
      startedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      branchCount: 4,
    };
    expect(partial.branchCount).toBe(4);
  });

  it('[LIVE-FIELDS-003] writes iter and maxIter to disk and reads them back', async () => {
    const iso = new Date().toISOString();
    const result = await writeLiveState(tmp, 'loop-step', {
      status: 'running',
      attempt: 1,
      startedAt: iso,
      lastUpdateAt: iso,
      iter: 3,
      maxIter: 10,
    });

    expect(result.isOk()).toBe(true);

    const raw = await readFile(join(tmp, 'live', 'loop-step.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['iter']).toBe(3);
    expect(parsed['maxIter']).toBe(10);
  });

  it('[LIVE-FIELDS-004] writes branchCount to disk and reads it back', async () => {
    const iso = new Date().toISOString();
    const result = await writeLiveState(tmp, 'branch-step', {
      status: 'running',
      attempt: 1,
      startedAt: iso,
      lastUpdateAt: iso,
      branchCount: 4,
    });

    expect(result.isOk()).toBe(true);

    const raw = await readFile(join(tmp, 'live', 'branch-step.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['branchCount']).toBe(4);
  });

  it('[LIVE-FIELDS-005] omitted optional fields are not present in the written JSON', async () => {
    const iso = new Date().toISOString();
    await writeLiveState(tmp, 'plain-step', {
      status: 'running',
      attempt: 1,
      startedAt: iso,
      lastUpdateAt: iso,
    });

    const raw = await readFile(join(tmp, 'live', 'plain-step.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect('iter' in parsed).toBe(false);
    expect('maxIter' in parsed).toBe(false);
    expect('branchCount' in parsed).toBe(false);
  });

  it('[LIVE-FIELDS-006] overwrites a previous write — latest values win', async () => {
    const iso = new Date().toISOString();

    await writeLiveState(tmp, 'loop-step', {
      status: 'running',
      attempt: 1,
      startedAt: iso,
      lastUpdateAt: iso,
      iter: 1,
      maxIter: 5,
    });

    await writeLiveState(tmp, 'loop-step', {
      status: 'running',
      attempt: 1,
      startedAt: iso,
      lastUpdateAt: iso,
      iter: 3,
      maxIter: 5,
    });

    const raw = await readFile(join(tmp, 'live', 'loop-step.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['iter']).toBe(3);
    expect(parsed['maxIter']).toBe(5);
  });
});
