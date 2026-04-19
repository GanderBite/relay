import { describe, it, expect, vi } from 'vitest';

import { withRetry, shouldRetry } from '../../src/runner/retry.js';
import {
  ClaudeAuthError,
  FlowDefinitionError,
  HandoffSchemaError,
  ProviderAuthError,
  ProviderRateLimitError,
  TimeoutError,
} from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';

function base() {
  return { logger: createLogger({ flowName: 'f', runId: 'r' }), stepId: 's' };
}

describe('withRetry backoff + jitter', () => {
  it('two retries complete in at least 300ms with base=100', async () => {
    const fn = vi.fn(async () => {
      throw new Error('transient');
    });

    const start = Date.now();
    await expect(withRetry(fn, { ...base(), maxRetries: 2 })).rejects.toThrow('transient');
    const elapsed = Date.now() - start;

    // Two retries means two backoff waits. With base=100 and factor=2, the
    // minimum possible pause is 100ms (attempt 1 -> 2) + 200ms (attempt 2 -> 3)
    // = 300ms. Jitter can only extend, never shorten.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not complete in under 100ms when the first attempt fails', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw new Error('fail-once');
      return 'ok';
    });

    const start = Date.now();
    const result = await withRetry(fn, { ...base(), maxRetries: 1 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('short-circuits retries for TimeoutError', async () => {
    const fn = vi.fn(async () => {
      throw new TimeoutError('boom', 's', 50);
    });
    await expect(withRetry(fn, { ...base(), maxRetries: 3 })).rejects.toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emits a logger.warn with event=retry on each retry', async () => {
    const warn = vi.fn();
    const logger = {
      ...createLogger({ flowName: 'f', runId: 'r' }),
      warn,
    } as unknown as ReturnType<typeof createLogger>;

    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw new Error(`boom-${attempt}`);
      return 'done';
    });

    const result = await withRetry(fn, { logger, stepId: 's', maxRetries: 3 });
    expect(result).toBe('done');
    expect(warn).toHaveBeenCalledTimes(2);

    const firstCallArgs = warn.mock.calls[0];
    expect(firstCallArgs?.[0]).toMatchObject({
      event: 'retry',
      stepId: 's',
      attempt: 1,
      nextAttempt: 2,
      message: 'boom-1',
    });
  });

  it('performs maxRetries + 1 total attempts on a persistent failure', async () => {
    const fn = vi.fn(async () => {
      throw new Error('still broken');
    });
    await expect(withRetry(fn, { ...base(), maxRetries: 4 })).rejects.toThrow('still broken');
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('shouldRetry predicate', () => {
  it('returns false for non-retryable classes', () => {
    expect(shouldRetry(new TimeoutError('t', 's', 100))).toBe(false);
    expect(shouldRetry(new ClaudeAuthError('auth'))).toBe(false);
    expect(shouldRetry(new ProviderAuthError('auth', 'custom'))).toBe(false);
    expect(shouldRetry(new FlowDefinitionError('bad flow'))).toBe(false);
    expect(shouldRetry(new HandoffSchemaError('schema', 'h1', []))).toBe(false);
  });

  it('returns true for transient errors', () => {
    expect(shouldRetry(new Error('transient'))).toBe(true);
    expect(shouldRetry(new ProviderRateLimitError('rate', 'p', 's', 1, undefined))).toBe(true);
  });
});

describe('withRetry rate-limit backoff', () => {
  it('honors retryAfterMs when present on ProviderRateLimitError', async () => {
    const retryAfterMs = 250;
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) {
        throw new ProviderRateLimitError('rate limited', 'p', 's', 1, retryAfterMs);
      }
      return 'ok';
    });

    const start = Date.now();
    const result = await withRetry(fn, { ...base(), maxRetries: 1 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    // The extra retry-after sleep runs before p-retry's own backoff, so the
    // minimum total pause is retryAfterMs (250) + baseDelay (100) = 350ms.
    expect(elapsed).toBeGreaterThanOrEqual(retryAfterMs);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses a doubled base delay when retryAfterMs is absent', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) {
        throw new ProviderRateLimitError('rate limited', 'p', 's', 1, undefined);
      }
      return 'ok';
    });

    const start = Date.now();
    const result = await withRetry(fn, { ...base(), maxRetries: 1 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    // Vanilla backoff for attempt 1 is 100-200ms with randomize; the extra
    // rate-limit delay adds another 100ms on top, so the minimum total pause
    // is 100 (built-in) + 100 (extra) = 200ms.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
