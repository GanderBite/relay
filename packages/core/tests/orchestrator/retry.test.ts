/**
 * Sprint 5 task_38 contract tests for withRetry.
 * References packages/core/src/orchestrator/retry.ts — not yet implemented.
 */
import { describe, expect, it, vi } from 'vitest';
import { HandoffOutputError, HandoffSchemaError, TimeoutError } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';
import { shouldRetry, withRetry } from '../../src/orchestrator/retry.js';

function base() {
  return { logger: createLogger({ flowName: 'f', runId: 'r' }), stepId: 's' };
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

  it('shouldRetry: HandoffOutputError is retryable; HandoffSchemaError is NOT', () => {
    expect(shouldRetry(new HandoffOutputError('missing', 'h', 'missing'))).toBe(true);
    expect(shouldRetry(new HandoffOutputError('bad json', 'h', 'invalid_json'))).toBe(true);
    expect(shouldRetry(new HandoffOutputError('mismatch', 'h', 'schema_mismatch'))).toBe(true);
    expect(shouldRetry(new HandoffSchemaError('def-bug', 'h', []))).toBe(false);
  });

  it('HandoffOutputError is retried: succeeds on attempt 2 within budget', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new HandoffOutputError('first attempt missing', 'h', 'missing');
      return 'ok';
    });
    const result = await withRetry(fn, { ...base(), maxRetries: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
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
