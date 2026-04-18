import type { Logger } from '../logger.js';
import { TimeoutError } from '../errors.js';
import { ERROR_CODES } from '../errors.js';

export interface WithRetryOptions {
  maxRetries: number;
  timeoutMs?: number;
  logger: Logger;
  stepId: string;
}

/**
 * Runs fn up to maxRetries+1 times total. TimeoutError is never retried;
 * other errors are retried until attempts are exhausted, then rethrown.
 *
 * The timeout races fn's promise; fn itself is not cancelled on timeout because
 * fn's signature carries no AbortSignal. The step-level abortSignal on the Runner
 * context is what actually stops in-flight work.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const { maxRetries, timeoutMs, logger, stepId } = opts;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      let result: T;

      if (timeoutMs !== undefined) {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timerId = setTimeout(() => {
            reject(new TimeoutError(`step "${stepId}" timed out after ${timeoutMs}ms`, stepId, timeoutMs));
          }, timeoutMs);
        });

        result = await Promise.race([fn(attempt), timeoutPromise]);
      } else {
        result = await fn(attempt);
      }

      return result;
    } catch (err: unknown) {
      if (err instanceof TimeoutError) {
        throw err;
      }

      if (attempt <= maxRetries) {
        const code = err instanceof Error && 'code' in err
          ? (err as { code: unknown }).code
          : ERROR_CODES.STEP_FAILURE;
        const message = err instanceof Error ? err.message : String(err);

        logger.warn(
          {
            event: 'retry',
            stepId,
            attempt,
            nextAttempt: attempt + 1,
            code,
            message,
          },
          `retrying step "${stepId}" (attempt ${attempt} failed)`,
        );
        continue;
      }

      throw err;
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  // Unreachable: the loop always returns or throws before exhausting.
  throw new Error('withRetry: unreachable');
}
