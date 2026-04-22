/**
 * Sprint 5 task_36 contract tests for executeParallel.
 * References packages/core/src/orchestrator/exec/parallel.ts — not yet implemented.
 */
import { describe, it, expect, vi } from 'vitest';

import { executeParallel } from '../../../src/orchestrator/exec/parallel.js';
import { runner } from '../../../src/race/runner.js';
import { RunnerFailureError } from '../../../src/errors.js';
import { createLogger } from '../../../src/logger.js';

function baseCtx() {
  return {
    logger: createLogger({ raceName: 'f', runId: 'r' }),
    abortSignal: new AbortController().signal,
    attempt: 1,
  };
}

describe('executeParallel (sprint 5 task_36)', () => {
  it('[EXEC-PARALLEL-001] dispatches branches concurrently (overlap in time)', async () => {
    const starts: number[] = [];
    const dispatch = vi.fn(async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true } as const;
    });

    const s = runner.parallel({ branches: ['x', 'y', 'z'] });
    const started = Date.now();
    await executeParallel(s, { ...baseCtx(), runnerId: s.id || 's', runner: s, dispatch });
    const elapsed = Date.now() - started;

    expect(dispatch).toHaveBeenCalledTimes(3);
    // Concurrent: total time < 3 * 100ms, usually ~100ms
    expect(elapsed).toBeLessThan(250);
    // Start timestamps should be within ~50ms of each other
    const spread = Math.max(...starts) - Math.min(...starts);
    expect(spread).toBeLessThan(50);
  });

  it('[EXEC-PARALLEL-002] any branch rejection surfaces as RunnerFailureError with aggregate details', async () => {
    const dispatch = vi.fn(async (id: string) => {
      if (id === 'y') throw new Error('boom');
      return { ok: true } as const;
    });
    const s = runner.parallel({ branches: ['x', 'y'] });
    await expect(
      executeParallel(s, { ...baseCtx(), runnerId: s.id || 's', runner: s, dispatch }),
    ).rejects.toBeInstanceOf(RunnerFailureError);
  });

  it('[EXEC-PARALLEL-003] on all-succeed, result.branches collects per-branch outcomes', async () => {
    const dispatch = vi.fn(async (id: string) => ({ id, ok: true }));
    const s = runner.parallel({ branches: ['x', 'y'] });
    const result = await executeParallel(s, {
      ...baseCtx(),
      runnerId: s.id || 's',
      runner: s,
      dispatch,
    });
    expect((result as { branches: unknown }).branches).toBeDefined();
  });

  it('[EXEC-PARALLEL-004] does not execute branch logic itself — only dispatches', async () => {
    const dispatch = vi.fn(async () => ({ ok: true } as const));
    const s = runner.parallel({ branches: ['a', 'b'] });
    await executeParallel(s, { ...baseCtx(), runnerId: s.id || 's', runner: s, dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, 'a');
    expect(dispatch).toHaveBeenNthCalledWith(2, 'b');
  });
});
