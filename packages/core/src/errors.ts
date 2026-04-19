import { z } from './zod.js';

// Stable error code constants — the CLI and doctor match on these without magic strings.
export const ERROR_CODES = {
  ATOMIC_WRITE: 'relay_ATOMIC_WRITE',
  AUTH_TIMEOUT: 'relay_AUTH_TIMEOUT',
  CLAUDE_AUTH: 'relay_CLAUDE_AUTH',
  FLOW_DEFINITION: 'relay_FLOW_DEFINITION',
  HANDOFF_IO: 'relay_HANDOFF_IO',
  HANDOFF_NOT_FOUND: 'relay_HANDOFF_NOT_FOUND',
  HANDOFF_SCHEMA: 'relay_HANDOFF_SCHEMA',
  HANDOFF_WRITE: 'relay_HANDOFF_WRITE',
  METRICS_WRITE: 'relay_METRICS_WRITE',
  PROVIDER_AUTH: 'relay_PROVIDER_AUTH',
  PROVIDER_CAPABILITY: 'relay_PROVIDER_CAPABILITY',
  PROVIDER_RATE_LIMIT: 'relay_PROVIDER_RATE_LIMIT',
  STATE_CORRUPT: 'relay_STATE_CORRUPT',
  STATE_NOT_FOUND: 'relay_STATE_NOT_FOUND',
  STATE_TRANSITION: 'relay_STATE_TRANSITION',
  STATE_VERSION_MISMATCH: 'relay_STATE_VERSION_MISMATCH',
  STATE_WRITE: 'relay_STATE_WRITE',
  STEP_FAILURE: 'relay_STEP_FAILURE',
  TIMEOUT: 'relay_TIMEOUT',
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
 * Thrown when the flow DSL is invalid — bad step references, cycles, unknown
 * providers, or unsatisfied capabilities. Always thrown at load time, before
 * any tokens are spent.
 *
 * CLI exit code: 2
 */
export class FlowDefinitionError extends PipelineError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    /** Override the code for subclasses that extend FlowDefinitionError. */
    code: ErrorCode = ERROR_CODES.FLOW_DEFINITION,
  ) {
    super(message, code, details);
    this.name = 'FlowDefinitionError';
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
export class StepFailureError extends PipelineError {
  readonly stepId: string;
  readonly attempt: number;

  constructor(message: string, stepId: string, attempt: number, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STEP_FAILURE, details);
    this.name = 'StepFailureError';
    this.stepId = stepId;
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
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.CLAUDE_AUTH, details);
    this.name = 'ClaudeAuthError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a handoff file fails Zod schema validation on read or write.
 *
 * CLI exit code: 4
 */
export class HandoffSchemaError extends PipelineError {
  readonly handoffId: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(
    message: string,
    handoffId: string,
    issues: z.core.$ZodIssue[],
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.HANDOFF_SCHEMA, details);
    this.name = 'HandoffSchemaError';
    this.handoffId = handoffId;
    this.issues = issues;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised during handoff read or list operations when the underlying filesystem
 * call fails for a reason other than ENOENT or a schema validation failure.
 */
export class HandoffIoError extends PipelineError {
  readonly handoffId: string | undefined;

  constructor(message: string, handoffId: string | undefined, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.HANDOFF_IO, details);
    this.name = 'HandoffIoError';
    this.handoffId = handoffId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when a handoff file is expected to exist but is absent on disk.
 */
export class HandoffNotFoundError extends PipelineError {
  readonly handoffId: string;

  constructor(message: string, handoffId: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.HANDOFF_NOT_FOUND, details);
    this.name = 'HandoffNotFoundError';
    this.handoffId = handoffId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when a handoff write (atomic or otherwise) fails with a filesystem error.
 */
export class HandoffWriteError extends PipelineError {
  readonly handoffId: string;

  constructor(message: string, handoffId: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.HANDOFF_WRITE, details);
    this.name = 'HandoffWriteError';
    this.handoffId = handoffId;
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
export class StateCorruptError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_CORRUPT, details);
    this.name = 'StateCorruptError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when state.json is absent in the run directory, indicating a fresh run
 * rather than a resumable one.
 */
export class StateNotFoundError extends PipelineError {
  readonly runDir: string;

  constructor(message: string, runDir: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_NOT_FOUND, details);
    this.name = 'StateNotFoundError';
    this.runDir = runDir;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when the StateMachine is asked to apply an illegal transition or
 * references a step id that does not exist in the loaded flow.
 */
export class StateTransitionError extends PipelineError {
  readonly stepId: string | undefined;

  constructor(message: string, stepId: string | undefined, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_TRANSITION, details);
    this.name = 'StateTransitionError';
    this.stepId = stepId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when persisted state was written by a different flow name or version
 * than the one currently loaded, making safe resumption impossible.
 */
export class StateVersionMismatchError extends PipelineError {
  readonly expected: { flowName: string; flowVersion: string };
  readonly actual: { flowName: string; flowVersion: string };

  constructor(
    message: string,
    expected: { flowName: string; flowVersion: string },
    actual: { flowName: string; flowVersion: string },
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.STATE_VERSION_MISMATCH, details);
    this.name = 'StateVersionMismatchError';
    this.expected = expected;
    this.actual = actual;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Raised when StateMachine fails to persist state.json via an atomic write.
 */
export class StateWriteError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ERROR_CODES.STATE_WRITE, details);
    this.name = 'StateWriteError';
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
  readonly stepId: string;
  readonly timeoutMs: number;

  constructor(
    message: string,
    stepId: string,
    timeoutMs: number,
    details?: Record<string, unknown>,
    /** Override the code for subclasses that extend TimeoutError. */
    code: ErrorCode = ERROR_CODES.TIMEOUT,
  ) {
    super(message, code, details);
    this.name = 'TimeoutError';
    this.stepId = stepId;
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
 * Carries `providerName` rather than a step id — auth runs before the DAG
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

/** Wrap a Zod parse error into a FlowDefinitionError with a prettified message. */
export function toFlowDefError(err: z.core.$ZodError, prefix: string): FlowDefinitionError {
  return new FlowDefinitionError(`${prefix}: ${z.prettifyError(err)}`);
}

/**
 * Thrown at flow-load time when a step requests a capability the configured
 * provider does not support. Extends `FlowDefinitionError` so the CLI maps it
 * to exit code 2.
 */
export class ProviderCapabilityError extends FlowDefinitionError {
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
 * rate-limit error from the underlying SDK). Distinct from `StepFailureError`
 * so the retry layer can apply a longer backoff base, and from `TimeoutError`
 * so retries are not short-circuited for a recoverable rate-limit condition.
 *
 * The original thrown value is preserved at `details.cause`.
 *
 * CLI exit code: 8
 */
export class ProviderRateLimitError extends PipelineError {
  readonly providerName: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    providerName: string,
    stepId: string,
    attempt: number,
    retryAfterMs: number | undefined,
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.PROVIDER_RATE_LIMIT, details);
    this.name = 'ProviderRateLimitError';
    this.providerName = providerName;
    this.stepId = stepId;
    this.attempt = attempt;
    this.retryAfterMs = retryAfterMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}
