import { err, ok, type Result } from 'neverthrow';

/**
 * Local error class for the `lookup` utility — signals a key that was
 * expected to exist but did not. Kept inside `util/map-utils.ts` because
 * this error never escapes core; it is always unwrapped or wrapped into
 * a domain error (FlowDefinitionError, etc.) at the immediate call site.
 */
export class ValueNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`value not found for key: ${key}`);
    this.name = 'ValueNotFoundError';
    this.key = key;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }
}

/**
 * Result-returning map lookup. Returns `ok(value)` on hit,
 * `err(ValueNotFoundError)` on miss. Use this instead of a throwing
 * "must get" helper so the Result boundary stays explicit.
 */
export function lookup<K, V>(map: ReadonlyMap<K, V>, key: K): Result<V, ValueNotFoundError> {
  const value = map.get(key);
  if (value === undefined) {
    return err(new ValueNotFoundError(String(key)));
  }
  return ok(value);
}

/**
 * Invariant-enforcing map lookup. Returns the value on hit; throws
 * `Error('Invariant violated: ' + invariantMsg)` on miss. Use only at
 * call sites where a missing key represents a programming bug — not a
 * recoverable domain error. This is the documented exception to the
 * neverthrow discipline: invariant violations are bugs, not domain errors.
 */
export function lookupOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K, invariantMsg: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error('Invariant violated: ' + invariantMsg);
  }
  return value;
}
