/**
 * Sprint 5 task_38 contract tests for withRetry.
 * References packages/core/src/orchestrator/retry.ts — not yet implemented.
 */
import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../../src/orchestrator/retry.js';
import { TimeoutError } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';

function base() {
  return { logger: createLogger({ raceName: 'f', runId: 'r' }), runnerId: 's' };
}

describe('withRetry (sprint 5 task_38)', () => {
  it('[RETRY-001] succeeds on the first attempt without retries', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { ...base(), maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('[RETRY-002] retries a rejected promise up to maxRetries before rethrowing', async () => {
    const fn = vi.fn(async (attempt: number) => {
      throw new Error(`boom-${attempt}`);
    });
    await expect(withRetry(fn, { ...base(), maxRetries: 2 })).rejects.toThrow('boom-3');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('[RETRY-003] does NOT retry TimeoutError automatically', async () => {
    const fn = vi.fn(async () => {
      throw new TimeoutError('timed out', 's', 200);
    });
    await expect(withRetry(fn, { ...base(), maxRetries: 3 })).rejects.toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('[RETRY-004] enforces timeoutMs per attempt via AbortController; rejects with TimeoutError', async () => {
    const started = Date.now();
    await expect(
      withRetry(() => new Promise(() => undefined), { ...base(), maxRetries: 0, timeoutMs: 120 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('[RETRY-005] passes the 1-based attempt number to fn on each call', async () => {
    const attempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error('retry');
      return 'done';
    });
    const result = await withRetry(fn, { ...base(), maxRetries: 3 });
    expect(result).toBe('done');
    expect(attempts).toEqual([1, 2, 3]);
  });
});
