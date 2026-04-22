import pRetry, { type RetryContext } from 'p-retry';

import type { Logger } from '../logger.js';
import {
  ClaudeAuthError,
  ERROR_CODES,
  RaceDefinitionError,
  BatonSchemaError,
  ProviderAuthError,
  TimeoutError,
} from '../errors.js';

export interface WithRetryOptions {
  maxRetries: number;
  timeoutMs?: number;
  logger: Logger;
  runnerId: string;
}

/**
 * Base backoff delay handed to p-retry as `minTimeout`. p-retry multiplies by
 * `factor^(attemptNumber-1)` and, with `randomize: true`, applies a 1x-2x
 * jitter multiplier on top.
 */
const BASE_DELAY_MS = 100;

/**
 * Errors that are non-retryable regardless of attempt budget. These represent
 * misconfiguration or invariant violations that will not heal on a second try.
 */
export function shouldRetry(err: unknown): boolean {
  if (err instanceof TimeoutError) return false;
  if (err instanceof ClaudeAuthError) return false;
  if (err instanceof ProviderAuthError) return false;
  if (err instanceof RaceDefinitionError) return false;
  if (err instanceof BatonSchemaError) return false;
  return true;
}

/**
 * Runs fn up to maxRetries+1 times total. TimeoutError and auth/definition
 * errors are never retried; other errors are retried with exponential backoff
 * and jitter, then rethrown once the budget is exhausted.
 *
 * Per-attempt timeout races fn's promise; fn itself is not cancelled on timeout
 * because fn's signature carries no AbortSignal. The step-level abortSignal on
 * the Runner context is what actually stops in-flight work.
 *
 * Backoff is delegated entirely to p-retry (exponential with jitter, starting
 * at BASE_DELAY_MS). ProviderRateLimitError is retried like any other transient
 * error; the `retryAfterMs` hint is surfaced on the error instance for
 * observability but is not used to extend the pause, because p-retry v7 exposes
 * no per-attempt delay override and layering a manual sleep on top would double
 * the effective wait. If a provider needs to enforce a longer cool-down, raise
 * BASE_DELAY_MS here rather than reintroducing a parallel sleep path.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const { maxRetries, timeoutMs, logger, runnerId } = opts;

  const attempt = async (attemptNumber: number): Promise<T> => {
    if (timeoutMs === undefined) {
      return fn(attemptNumber);
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          reject(new TimeoutError(`runner "${runnerId}" timed out after ${timeoutMs}ms`, runnerId, timeoutMs));
        }, timeoutMs);
      });
      return await Promise.race([fn(attemptNumber), timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  };

  const onFailedAttempt = (context: RetryContext): void => {
    const { error, attemptNumber, retriesLeft } = context;

    if (!shouldRetry(error) || retriesLeft === 0) {
      return;
    }

    const code = error instanceof Error && 'code' in error
      ? (error as { code: unknown }).code
      : ERROR_CODES.STEP_FAILURE;
    const message = error instanceof Error ? error.message : String(error);

    logger.warn(
      {
        event: 'retry',
        runnerId,
        attempt: attemptNumber,
        nextAttempt: attemptNumber + 1,
        code,
        message,
      },
      `retrying runner "${runnerId}" (attempt ${attemptNumber} failed)`,
    );
  };

  return pRetry(attempt, {
    retries: maxRetries,
    factor: 2,
    minTimeout: BASE_DELAY_MS,
    randomize: true,
    shouldRetry: (context) => shouldRetry(context.error),
    onFailedAttempt,
  });
}
