import type { ZodIssue } from 'zod';

// Stable error code constants — the CLI and doctor match on these without magic strings.
export const ERROR_CODES = {
  FLOW_DEFINITION:     'relay_FLOW_DEFINITION',
  STEP_FAILURE:        'relay_STEP_FAILURE',
  CLAUDE_AUTH:         'relay_CLAUDE_AUTH',
  HANDOFF_SCHEMA:      'relay_HANDOFF_SCHEMA',
  TIMEOUT:             'relay_TIMEOUT',
  PROVIDER_AUTH:       'relay_PROVIDER_AUTH',
  PROVIDER_CAPABILITY: 'relay_PROVIDER_CAPABILITY',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Base class for all Relay runtime errors.
 * Carries a stable machine-readable `code` and optional structured `details`.
 */
export class PipelineError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
  ) {
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
    code: string = ERROR_CODES.FLOW_DEFINITION,
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

  constructor(
    message: string,
    stepId: string,
    attempt: number,
    details?: Record<string, unknown>,
  ) {
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
  readonly issues: ZodIssue[];

  constructor(
    message: string,
    handoffId: string,
    issues: ZodIssue[],
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
  ) {
    super(message, ERROR_CODES.TIMEOUT, details);
    this.name = 'TimeoutError';
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown by a provider's `authenticate()` method when credentials are missing
 * or invalid for that provider.
 */
export class ProviderAuthError extends PipelineError {
  readonly providerName: string;

  constructor(
    message: string,
    providerName: string,
    details?: Record<string, unknown>,
  ) {
    super(message, ERROR_CODES.PROVIDER_AUTH, details);
    this.name = 'ProviderAuthError';
    this.providerName = providerName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
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
