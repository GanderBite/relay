import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostTracker, type RunnerMetrics } from '../src/cost.js';
import { RaceStateCorruptError } from '../src/errors.js';

function metric(partial: Partial<RunnerMetrics> & { runnerId: string; model: string }): RunnerMetrics {
  return {
    raceName: 'f',
    runId: 'r',
    timestamp: new Date().toISOString(),
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 1,
    durationMs: 0,
    ...partial,
  };
}

describe('CostTracker', () => {
  let tmp: string;
  let metricsPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-cost-'));
    metricsPath = join(tmp, 'metrics.json');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[COST-001] record() appends and persists metrics.json atomically', async () => {
    const tracker = new CostTracker(metricsPath);
    const r1 = await tracker.record(
      metric({ runnerId: 'a', model: 'sonnet', tokensIn: 10, tokensOut: 5, costUsd: 0.01 }),
    );
    const r2 = await tracker.record(
      metric({ runnerId: 'b', model: 'sonnet', tokensIn: 20, tokensOut: 10, costUsd: 0.02 }),
    );
    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    const raw = await readFile(metricsPath, 'utf8');
    const arr = JSON.parse(raw) as RunnerMetrics[];
    expect(arr).toHaveLength(2);
    expect(arr[0].runnerId).toBe('a');
    expect(arr[1].runnerId).toBe('b');
  });

  it('[COST-002] summary aggregates totalUsd and totalTokens across steps', async () => {
    const tracker = new CostTracker(metricsPath);
    await tracker.record(metric({ runnerId: 'a', model: 'sonnet', tokensIn: 100, tokensOut: 50, costUsd: 0.01 }));
    await tracker.record(metric({ runnerId: 'b', model: 'sonnet', tokensIn: 200, tokensOut: 100, costUsd: 0.02 }));
    await tracker.record(metric({ runnerId: 'c', model: 'sonnet', tokensIn: 50, tokensOut: 25, costUsd: 0.005 }));
    const s = tracker.summary();
    expect(s.totalUsd).toBeCloseTo(0.035, 5);
    expect(s.totalTokens).toBe(525);
    expect(s.perStep).toHaveLength(3);
  });

  it('[COST-003] summary.perModel groups by model', async () => {
    const tracker = new CostTracker(metricsPath);
    await tracker.record(metric({ runnerId: 'a', model: 'sonnet', costUsd: 0.01 }));
    await tracker.record(metric({ runnerId: 'b', model: 'sonnet', costUsd: 0.02 }));
    await tracker.record(metric({ runnerId: 'c', model: 'opus', costUsd: 0.05 }));
    const s = tracker.summary();
    expect(Object.keys(s.perModel).sort()).toEqual(['opus', 'sonnet']);
    expect(s.perModel.sonnet.totalUsd).toBeCloseTo(0.03, 5);
    expect(s.perModel.sonnet.stepCount).toBe(2);
    expect(s.perModel.opus.totalUsd).toBeCloseTo(0.05, 5);
    expect(s.perModel.opus.stepCount).toBe(1);
  });

  it('[COST-004] load() rebuilds in-memory state from disk', async () => {
    const a = new CostTracker(metricsPath);
    await a.record(metric({ runnerId: 'a', model: 'sonnet', tokensIn: 10, tokensOut: 5, costUsd: 0.01 }));
    await a.record(metric({ runnerId: 'b', model: 'sonnet', tokensIn: 20, tokensOut: 10, costUsd: 0.02 }));
    const sA = a.summary();

    const b = new CostTracker(metricsPath);
    const lr = await b.load();
    expect(lr.isOk()).toBe(true);
    const sB = b.summary();
    expect(sB.totalUsd).toBeCloseTo(sA.totalUsd, 5);
    expect(sB.totalTokens).toBe(sA.totalTokens);
    expect(sB.perStep).toHaveLength(sA.perStep.length);
  });

  it('[COST-005] undefined costUsd contributes 0 (never NaN)', async () => {
    const tracker = new CostTracker(metricsPath);
    await tracker.record(metric({ runnerId: 'a', model: 'sonnet', costUsd: 0.01 }));
    await tracker.record(metric({ runnerId: 'b', model: 'sonnet' /* no costUsd */ }));
    const s = tracker.summary();
    expect(Number.isFinite(s.totalUsd)).toBe(true);
    expect(s.totalUsd).toBeCloseTo(0.01, 5);
    expect(s.costKnown).toBe(1);
    expect(s.costTotal).toBe(2);
  });

  it('load() on corrupt metrics.json returns RaceStateCorruptError', async () => {
    await writeFile(metricsPath, 'not valid json', 'utf8');
    const tracker = new CostTracker(metricsPath);
    const r = await tracker.load();
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(RaceStateCorruptError);
  });
});
