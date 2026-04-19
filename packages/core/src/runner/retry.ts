import pRetry, { type RetryContext } from 'p-retry';

import type { Logger } from '../logger.js';
import {
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffSchemaError,
  ProviderAuthError,
  ProviderRateLimitError,
  TimeoutError,
} from '../errors.js';

export interface WithRetryOptions {
  maxRetries: number;
  timeoutMs?: number;
  logger: Logger;
  stepId: string;
}

/**
 * Base backoff for a vanilla retryable error. Doubled for rate-limit errors
 * without an explicit retry-after hint.
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
  if (err instanceof FlowDefinitionError) return false;
  if (err instanceof HandoffSchemaError) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * ProviderRateLimitError honors `retryAfterMs` from the error if present; else
 * the next-attempt delay is doubled relative to the vanilla backoff.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const { maxRetries, timeoutMs, logger, stepId } = opts;

  const attempt = async (attemptNumber: number): Promise<T> => {
    if (timeoutMs === undefined) {
      return fn(attemptNumber);
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          reject(new TimeoutError(`step "${stepId}" timed out after ${timeoutMs}ms`, stepId, timeoutMs));
        }, timeoutMs);
      });
      return await Promise.race([fn(attemptNumber), timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  };

  const onFailedAttempt = async (context: RetryContext): Promise<void> => {
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
        stepId,
        attempt: attemptNumber,
        nextAttempt: attemptNumber + 1,
        code,
        message,
      },
      `retrying step "${stepId}" (attempt ${attemptNumber} failed)`,
    );

    // Rate-limit-aware backoff: honor Retry-After if the provider supplied it,
    // otherwise add an extra BASE_DELAY_MS*2^(attempt-1) on top of p-retry's
    // backoff so the effective base delay is doubled for rate-limit errors.
    if (error instanceof ProviderRateLimitError) {
      if (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
        await sleep(error.retryAfterMs);
      } else {
        await sleep(BASE_DELAY_MS * 2 ** (attemptNumber - 1));
      }
    }
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
