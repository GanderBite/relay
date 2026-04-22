import { z } from './zod.js';

// Stable error code constants — the CLI and doctor match on these without magic strings.
export const ERROR_CODES = {
  ATOMIC_WRITE: 'relay_ATOMIC_WRITE',
  AUTH_TIMEOUT: 'relay_AUTH_TIMEOUT',
  CLAUDE_AUTH: 'relay_CLAUDE_AUTH',
  RACE_DEFINITION: 'relay_RACE_DEFINITION',
  BATON_IO: 'relay_BATON_IO',
  BATON_NOT_FOUND: 'relay_BATON_NOT_FOUND',
  BATON_SCHEMA: 'relay_BATON_SCHEMA',
  BATON_WRITE: 'relay_BATON_WRITE',
  METRICS_WRITE: 'relay_METRICS_WRITE',
  NO_PROVIDER: 'E_NO_PROVIDER',
  PROVIDER_AUTH: 'relay_PROVIDER_AUTH',
  PROVIDER_CAPABILITY: 'relay_PROVIDER_CAPABILITY',
  PROVIDER_RATE_LIMIT: 'relay_PROVIDER_RATE_LIMIT',
  STATE_CORRUPT: 'relay_STATE_CORRUPT',
  STATE_NOT_FOUND: 'relay_STATE_NOT_FOUND',
  STATE_TRANSITION: 'relay_STATE_TRANSITION',
  STATE_VERSION_MISMATCH: 'relay_STATE_VERSION_MISMATCH',
  STATE_WRITE: 'relay_STATE_WRITE',
  RUNNER_FAILURE: 'relay_RUNNER_FAILURE',
  TIMEOUT: 'relay_TIMEOUT',
  TOS_LEAK_BLOCKED: 'E_TOS_LEAK_BLOCKED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Base class for all Relay runtime errors.
 * Carries a stable machine-readable `code` and optional structured `details`.
 */
export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, code: ErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when the race DSL is invalid — bad step references, cycles, unknown
 * providers, or unsatisfied capabilities. Always thrown at load time, before
 * any tokens are spent.
 *
 * CLI exit code: 2
 */
export class RaceDefinitionError extends PipelineError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    /** Override the code for subclasses that extend RaceDefinitionError. */
    code: ErrorCode = ERROR_CODES.RACE_DEFINITION,
  ) {
    super(message, code, details);
    this.name = 'RaceDefinitionError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a step exits non-zero or throws an unhandled error after all
 * retry attempts are exhausted.
 *
 * CLI exit code: 1
 */
export class RunnerFailureError extends PipelineError {
  readonly runnerId: string;
  readonly attempt: number;

  constructor(message: string, runnerId: string, attempt: number, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.RUNNER_FAILURE, details);
    this.name = 'RunnerFailureError';
    this.runnerId = runnerId;
    this.attempt = attempt;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when the environment is unsafe to spawn Claude — either
 * `ANTHROPIC_API_KEY` is present without an explicit opt-in, or the
 * subscription token is absent. Checked before any subprocess is launched.
 *
 * This is the subscription-billing safety guard specific to the Claude backend.
 * Generic provider auth misconfiguration uses `ProviderAuthError` instead.
 *
 * CLI exit code: 3
 */
export class ClaudeAuthError extends PipelineError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    /** Override the code for subclasses that extend ClaudeAuthError. */
    code: ErrorCode = ERROR_CODES.CLAUDE_AUTH,
  ) {
    super(message, code, details);
    this.name = 'ClaudeAuthError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a subscription OAuth token would otherwise be routed to a
 * provider whose terms forbid subscription credentials. Carries a distinct
 * code so the CLI and tests can branch on the TOS-leak case specifically
 * rather than the generic auth-misconfiguration case.
 *
 * Example: `CLAUDE_CODE_OAUTH_TOKEN` is present in the environment but the
 * caller selected the API-billed claude-agent-sdk provider — Anthropic's
 * commercial terms do not permit subscription tokens to be used through
 * the SDK, so the run is blocked before any subprocess is launched.
 *
 * CLI exit code: 3 (shares the auth-error exit code with `ClaudeAuthError`).
 */
export class SubscriptionTosLeakError extends ClaudeAuthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details, ERROR_CODES.TOS_LEAK_BLOCKED);
    this.name = 'SubscriptionTosLeakError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a baton file fails Zod schema validation on read or write.
 *
 * CLI exit code: 4
 */
export class BatonSchemaError extends PipelineError {
  readonly batonId: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(
    message: string,
    batonId: string,
    issues: z.core.$ZodIssue[],
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.BATON_SCHEMA, details);
    this.name = 'BatonSchemaError';
    this.batonId = batonId;
    this.issues = issues;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised during baton read or list operations when the underlying filesystem
 * call fails for a reason other than ENOENT or a schema validation failure.
 */
export class BatonIoError extends PipelineError {
  readonly batonId: string | undefined;

  constructor(message: string, batonId: string | undefined, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.BATON_IO, details);
    this.name = 'BatonIoError';
    this.batonId = batonId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when a baton file is expected to exist but is absent on disk.
 */
export class BatonNotFoundError extends PipelineError {
  readonly batonId: string;

  constructor(message: string, batonId: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.BATON_NOT_FOUND, details);
    this.name = 'BatonNotFoundError';
    this.batonId = batonId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when a baton write (atomic or otherwise) fails with a filesystem error.
 */
export class BatonWriteError extends PipelineError {
  readonly batonId: string;

  constructor(message: string, batonId: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.BATON_WRITE, details);
    this.name = 'BatonWriteError';
    this.batonId = batonId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when CostTracker fails to persist metrics.json via an atomic write.
 */
export class MetricsWriteError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.METRICS_WRITE, details);
    this.name = 'MetricsWriteError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when state.json exists but cannot be parsed or does not match the
 * expected shape. Indicates a corrupt or manually-edited state file.
 */
export class RaceStateCorruptError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_CORRUPT, details);
    this.name = 'RaceStateCorruptError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when state.json is absent in the run directory, indicating a fresh run
 * rather than a resumable one.
 */
export class RaceStateNotFoundError extends PipelineError {
  readonly runDir: string;

  constructor(message: string, runDir: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_NOT_FOUND, details);
    this.name = 'RaceStateNotFoundError';
    this.runDir = runDir;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when the RaceStateMachine is asked to apply an illegal transition or
 * references a runner id that does not exist in the loaded race.
 */
export class RaceStateTransitionError extends PipelineError {
  readonly runnerId: string | undefined;

  constructor(message: string, runnerId: string | undefined, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_TRANSITION, details);
    this.name = 'RaceStateTransitionError';
    this.runnerId = runnerId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when persisted state was written by a different race name or version
 * than the one currently loaded, making safe resumption impossible.
 */
export class RaceStateVersionMismatchError extends PipelineError {
  readonly expected: { raceName: string; raceVersion: string };
  readonly actual: { raceName: string; raceVersion: string };

  constructor(
    message: string,
    expected: { raceName: string; raceVersion: string },
    actual: { raceName: string; raceVersion: string },
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.STATE_VERSION_MISMATCH, details);
    this.name = 'RaceStateVersionMismatchError';
    this.expected = expected;
    this.actual = actual;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when RaceStateMachine fails to persist state.json via an atomic write.
 */
export class RaceStateWriteError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_WRITE, details);
    this.name = 'RaceStateWriteError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a step exceeds its configured `timeoutMs` budget.
 *
 * CLI exit code: 5
 */
export class TimeoutError extends PipelineError {
  readonly runnerId: string;
  readonly timeoutMs: number;

  constructor(
    message: string,
    runnerId: string,
    timeoutMs: number,
    details?: Record<string, unknown>,
    /** Override the code for subclasses that extend TimeoutError. */
    code: ErrorCode = ERROR_CODES.TIMEOUT,
  ) {
    super(message, code, details);
    this.name = 'TimeoutError';
    this.runnerId = runnerId;
    this.timeoutMs = timeoutMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a provider's `authenticate()` call fails to settle within the
 * configured `authTimeoutMs` budget. The Runner enforces this before any step
 * executes so a misconfigured CLI probe or a buggy custom provider cannot hang
 * the run indefinitely with no observable progress.
 *
 * Carries `providerName` rather than a runner id — auth runs before the DAG
 * walker, so no step is in flight when this fires.
 *
 * CLI exit code: 5 (shares the timeout exit code with `TimeoutError`).
 */
export class AuthTimeoutError extends TimeoutError {
  readonly providerName: string;

  constructor(
    message: string,
    providerName: string,
    timeoutMs: number,
    details?: Record<string, unknown>,
  ) {
    super(message, '', timeoutMs, details, ERROR_CODES.AUTH_TIMEOUT);
    this.name = 'AuthTimeoutError';
    this.providerName = providerName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown by a provider's `authenticate()` method when credentials are missing
 * or invalid for that provider.
 *
 * Maps to CLI exit code 6 (provider auth / environment error). Distinct from
 * `ClaudeAuthError` (exit 3) — that one is the subscription-billing safety
 * guard for the specific Claude backend; `ProviderAuthError` is the generic
 * fall-through for every other provider's auth misconfiguration.
 */
export class ProviderAuthError extends PipelineError {
  readonly providerName: string;

  constructor(message: string, providerName: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.PROVIDER_AUTH, details);
    this.name = 'ProviderAuthError';
    this.providerName = providerName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown (via Result.err) when atomicWriteText / atomicWriteJson fails
 * irrecoverably. Carries the underlying Node errno (EXDEV, EACCES, etc.)
 * so callers can discriminate transient-vs-terminal cases.
 * Maps to CLI exit code 7 (I/O error).
 */
export class AtomicWriteError extends PipelineError {
  readonly path: string;
  readonly errno: string | undefined;

  constructor(
    message: string,
    path: string,
    errno: string | undefined,
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.ATOMIC_WRITE, details);
    this.name = 'AtomicWriteError';
    this.path = path;
    this.errno = errno;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** Wrap a Zod parse error into a RaceDefinitionError with a prettified message. */
export function toRaceDefError(err: z.core.$ZodError, prefix: string): RaceDefinitionError {
  return new RaceDefinitionError(`${prefix}: ${z.prettifyError(err)}`);
}

/**
 * Raised when no provider is configured — neither a CLI flag, nor a race-level
 * settings.json, nor a global settings.json carries a `provider` value.
 *
 * CLI exit code: 2 (shares RaceDefinitionError's exit code — the run cannot
 * proceed before any tokens are spent).
 */
export class NoProviderConfiguredError extends PipelineError {
  constructor(details?: Record<string, unknown>) {
    super(
      'no provider configured. run `relay init` to pick one, or pass `--provider claude-cli` or `--provider claude-agent-sdk`.',
      ERROR_CODES.NO_PROVIDER,
      details,
    );
    this.name = 'NoProviderConfiguredError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown at race-load time when a runner requests a capability the configured
 * provider does not support. Extends `RaceDefinitionError` so the CLI maps it
 * to exit code 2.
 */
export class ProviderCapabilityError extends RaceDefinitionError {
  readonly providerName: string;
  readonly capability: string;

  constructor(
    message: string,
    providerName: string,
    capability: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details, ERROR_CODES.PROVIDER_CAPABILITY);
    this.name = 'ProviderCapabilityError';
    this.providerName = providerName;
    this.capability = capability;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a provider reports a rate-limit response (HTTP 429 or a typed
 * rate-limit error from the underlying SDK). Distinct from `RunnerFailureError`
 * so the retry layer can apply a longer backoff base, and from `TimeoutError`
 * so retries are not short-circuited for a recoverable rate-limit condition.
 *
 * The original thrown value is preserved at `details.cause`.
 *
 * CLI exit code: 8
 */
export class ProviderRateLimitError extends PipelineError {
  readonly providerName: string;
  readonly runnerId: string;
  readonly attempt: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    providerName: string,
    runnerId: string,
    attempt: number,
    retryAfterMs: number | undefined,
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.PROVIDER_RATE_LIMIT, details);
    this.name = 'ProviderRateLimitError';
    this.providerName = providerName;
    this.runnerId = runnerId;
    this.attempt = attempt;
    this.retryAfterMs = retryAfterMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}
