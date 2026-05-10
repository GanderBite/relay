/**
 * Per-error-class handler registry and the makeHandler factory.
 *
 * Each entry maps an ERROR_CODES string key to an exit code and a formatted
 * multi-line error block. makeHandler wraps the typed format callback with an
 * instanceof guard so the callback receives a narrowed type without any `as`
 * cast.
 */

import {
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  FlowImportError,
  HandoffSchemaError,
  LoopMaxIterationsError,
  type PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '@ganderbite/relay-core';
import { red } from '../color.js';
import { FlowLoadError } from '../flow-loader.js';
import { EXIT_CODES } from './codes.js';
import {
  formatAuthTimeout,
  formatClaudeAuth,
  formatFlowDefinition,
  formatFlowImport,
  formatFlowInvalid,
  formatFlowNotFound,
  formatHandoffSchema,
  formatLoopMaxIterations,
  formatProviderAuth,
  formatProviderCapability,
  formatProviderRateLimit,
  formatStepFailure,
  formatTimeout,
} from './formatters.js';
import { BLANK, INDENT, remediation } from './helpers.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public handler shape — generic over the specific PipelineError subclass it formats. */
export type ErrorHandler<T extends PipelineError> = {
  exitCode: number;
  format: (e: T) => string;
};

/** Internal storage shape with the generic parameter erased. */
export type RegistryEntry = {
  exitCode: number;
  format: (e: PipelineError) => string;
};

// ---------------------------------------------------------------------------
// makeHandler
// ---------------------------------------------------------------------------

/**
 * Build a registry entry from an `ErrorHandler<T>`. Runs an instanceof guard
 * before invoking the typed callback; emits a minimal fallback on mismatch.
 */
export function makeHandler<T extends PipelineError>(
  exitCode: number,
  guard: (e: PipelineError) => e is T,
  format: (e: T) => string,
): RegistryEntry {
  return {
    exitCode,
    format: (e) => {
      if (!guard(e)) return `${e.name}: ${e.message}`;
      return format(e);
    },
  };
}

// ---------------------------------------------------------------------------
// ERROR_CODES mapping reference
//
// The table below lists every relay_* code from @ganderbite/relay-core's
// ERROR_CODES and records whether it is handled here (with the resulting exit
// code) or will fall through to the exitCodeFor fallback (exit 1).
//
//   relay_ATOMIC_WRITE            — unmapped  → exit 1 (runner_failure)
//   relay_AUTH_TIMEOUT            — mapped    → exit 5 (timeout)
//   relay_CLAUDE_AUTH             — mapped    → exit 3 (auth_error)
//   relay_FLOW_DEFINITION         — mapped    → exit 2 (definition_error)
//   relay_FLOW_IMPORT             — mapped    → exit 2 (definition_error)
//   relay_FLOW_INVALID            — mapped    → exit 2 (definition_error)
//   relay_FLOW_NOT_FOUND          — mapped    → exit 1 (runner_failure)
//   relay_HANDOFF_IO              — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_NOT_FOUND       — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_OUTPUT          — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_SCHEMA          — mapped    → exit 4 (handoff_error)
//   relay_HANDOFF_WRITE           — unmapped  → exit 1 (runner_failure)
//   relay_METRICS_WRITE           — unmapped  → exit 1 (runner_failure)
//   relay_NO_PROVIDER             — mapped    → exit 6 (no_provider)
//   relay_PROVIDER_AUTH           — mapped    → exit 3 (auth_error)
//   relay_PROVIDER_CAPABILITY     — mapped    → exit 2 (definition_error)
//   relay_PROVIDER_RATE_LIMIT     — mapped    → exit 8 (rate_limit)
//   relay_STATE_CORRUPT           — unmapped  → exit 1 (runner_failure)
//   relay_STATE_NOT_FOUND         — unmapped  → exit 1 (runner_failure)
//   relay_STATE_TRANSITION        — unmapped  → exit 1 (runner_failure)
//   relay_STATE_VERSION_MISMATCH  — unmapped  → exit 1 (runner_failure)
//   relay_STATE_WRITE             — unmapped  → exit 1 (runner_failure)
//   relay_STEP_FAILURE            — mapped    → exit 1 (runner_failure)
//   relay_TIMEOUT                 — mapped    → exit 5 (timeout)
//   relay_LOOP_MAX_ITERATIONS_EXCEEDED — mapped → exit 9 (loop_exhausted)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const errorRegistry = new Map<string, RegistryEntry>([
  // StepFailureError — step exited non-zero
  [
    ERROR_CODES.STEP_FAILURE,
    makeHandler(
      EXIT_CODES.runner_failure,
      (e): e is StepFailureError => e instanceof StepFailureError,
      formatStepFailure,
    ),
  ],

  // FlowDefinitionError — with special handling for cycle detection
  [
    ERROR_CODES.FLOW_DEFINITION,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowDefinitionError => e instanceof FlowDefinitionError,
      formatFlowDefinition,
    ),
  ],

  // ProviderCapabilityError — subclass of FlowDefinitionError, same exit code + format
  [
    ERROR_CODES.PROVIDER_CAPABILITY,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is ProviderCapabilityError => e instanceof ProviderCapabilityError,
      formatProviderCapability,
    ),
  ],

  // FlowImportError — absent, unparseable, or missing-default-export
  [
    ERROR_CODES.FLOW_IMPORT,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowImportError => e instanceof FlowImportError,
      formatFlowImport,
    ),
  ],

  // ClaudeAuthError — two distinct shapes
  [
    ERROR_CODES.CLAUDE_AUTH,
    makeHandler(
      EXIT_CODES.auth_error,
      (e): e is ClaudeAuthError => e instanceof ClaudeAuthError,
      formatClaudeAuth,
    ),
  ],

  // AuthTimeoutError — must be registered before TimeoutError (same exit code, different format)
  [
    ERROR_CODES.AUTH_TIMEOUT,
    makeHandler(
      EXIT_CODES.timeout,
      (e): e is AuthTimeoutError => e instanceof AuthTimeoutError,
      formatAuthTimeout,
    ),
  ],

  // TimeoutError — step exceeded its timeoutMs budget
  [
    ERROR_CODES.TIMEOUT,
    makeHandler(
      EXIT_CODES.timeout,
      (e): e is TimeoutError => e instanceof TimeoutError,
      formatTimeout,
    ),
  ],

  // HandoffSchemaError
  [
    ERROR_CODES.HANDOFF_SCHEMA,
    makeHandler(
      EXIT_CODES.handoff_error,
      (e): e is HandoffSchemaError => e instanceof HandoffSchemaError,
      formatHandoffSchema,
    ),
  ],

  // NoProviderConfiguredError — no typed fields accessed; plain RegistryEntry shape
  [
    ERROR_CODES.NO_PROVIDER,
    {
      exitCode: EXIT_CODES.no_provider,
      format: () =>
        [
          red('✕ no provider configured'),
          BLANK,
          `${INDENT}Relay does not know which backend to run your flow on.`,
          BLANK,
          remediation('relay init                            pick a provider interactively'),
          remediation(
            'relay run <flow> --provider claude-cli   use the subscription-safe provider',
          ),
        ].join('\n'),
    },
  ],

  // ProviderAuthError — generic provider auth misconfiguration
  [
    ERROR_CODES.PROVIDER_AUTH,
    makeHandler(
      EXIT_CODES.auth_error,
      (e): e is ProviderAuthError => e instanceof ProviderAuthError,
      formatProviderAuth,
    ),
  ],

  // ProviderRateLimitError — rate limited by provider
  [
    ERROR_CODES.PROVIDER_RATE_LIMIT,
    makeHandler(
      EXIT_CODES.rate_limit,
      (e): e is ProviderRateLimitError => e instanceof ProviderRateLimitError,
      formatProviderRateLimit,
    ),
  ],

  // LoopMaxIterationsError — loop step exhausted its iteration cap
  [
    ERROR_CODES.LOOP_MAX_ITERATIONS,
    makeHandler(
      EXIT_CODES.loop_exhausted,
      (e): e is LoopMaxIterationsError => e instanceof LoopMaxIterationsError,
      formatLoopMaxIterations,
    ),
  ],

  // FlowLoadError — FLOW_NOT_FOUND
  [
    ERROR_CODES.FLOW_NOT_FOUND,
    makeHandler(
      EXIT_CODES.runner_failure,
      (e): e is FlowLoadError =>
        e instanceof FlowLoadError && e.code === ERROR_CODES.FLOW_NOT_FOUND,
      formatFlowNotFound,
    ),
  ],

  // FlowLoadError — FLOW_INVALID
  [
    ERROR_CODES.FLOW_INVALID,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowLoadError => e instanceof FlowLoadError && e.code === ERROR_CODES.FLOW_INVALID,
      formatFlowInvalid,
    ),
  ],
]);
