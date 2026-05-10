import { AwaitingInputSignal } from '../errors.js';

/**
 * Internal marker for aborts surfaced through the step's flow. A dedicated
 * class keeps `instanceof` checks unambiguous without pulling DOMException
 * across the public surface. Used by the auth bootstrap, the DAG walker, and
 * the run/resume entry points so each can distinguish a controlled abort from
 * a real failure during cleanup.
 */
export class RunAbortedError extends Error {
  constructor(message = 'run aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortLike(err: unknown): boolean {
  if (err instanceof RunAbortedError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

export function isAwaitingInputSignal(err: unknown): err is AwaitingInputSignal {
  return err instanceof AwaitingInputSignal;
}

export function errorMessageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
