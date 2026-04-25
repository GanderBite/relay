import { z } from './zod.js';

// Stable error code constants — the CLI and doctor match on these without magic strings.
export const ERROR_CODES = {
  ATOMIC_WRITE: 'relay_ATOMIC_WRITE',
  AUTH_TIMEOUT: 'relay_AUTH_TIMEOUT',
  CLAUDE_AUTH: 'relay_CLAUDE_AUTH',
  FLOW_DEFINITION: 'relay_FLOW_DEFINITION',
  FLOW_INVALID: 'relay_FLOW_INVALID',
  FLOW_NOT_FOUND: 'relay_FLOW_NOT_FOUND',
  HANDOFF_IO: 'relay_HANDOFF_IO',
  HANDOFF_NOT_FOUND: 'relay_HANDOFF_NOT_FOUND',
  HANDOFF_SCHEMA: 'relay_HANDOFF_SCHEMA',
  HANDOFF_WRITE: 'relay_HANDOFF_WRITE',
  METRICS_WRITE: 'relay_METRICS_WRITE',
  NO_PROVIDER: 'relay_NO_PROVIDER',
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
 *
 * The `D` generic parameter lets subclasses narrow `details` to a class-specific
 * shape. The default `Record<string, unknown>` preserves compatibility for
 * direct callers (settings loaders, worktree helpers, tests) that construct a
 * `PipelineError` without a typed details interface.
 */
export class PipelineError<
  D extends Record<string, unknown> = Record<string, unknown>,
> extends Error {
  readonly code: ErrorCode;
  readonly details: D | undefined;

  constructor(message: string, code: ErrorCode, details?: D) {
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
 * Typed details for `FlowDefinitionError`.
 *
 * Covers the optional fields currently attached at throw sites — cycle
 * detection in the DAG builder, JSON parse causes bubbled up from
 * `util/json.ts`, handoff id validation, and multi-root entry errors.
 */
export interface FlowDefinitionDetails extends Record<string, unknown> {
  /** Ordered list of step ids forming a detected dependency cycle. */
  cyclePath?: string[];
  /** Root step ids when a flow has more than one entry candidate. */
  rootSteps?: string[];
  /** Handoff id that failed validation. */
  handoffId?: string;
  /** Resolved path when a handoff id escapes the store root. */
  resolved?: string;
  /** Store-root path paired with `resolved` for path-escape diagnostics. */
  root?: string;
  /** Underlying cause — JSON parse message, schema issues, or similar. */
  cause?: unknown;
  /** Flow file path when a resume-time import fails. */
  flowPath?: string;
  /** Prompt step id when no provider resolved during dispatch. */
  stepId?: string;
}

/**
 * Thrown when the flow DSL is invalid — bad step references, cycles, unknown
 * providers, or unsatisfied capabilities. Always thrown at load time, before
 * any tokens are spent.
 *
 * CLI exit code: 2
 */
export class FlowDefinitionError extends PipelineError<FlowDefinitionDetails> {
  constructor(
    message: string,
    details?: FlowDefinitionDetails,
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
 * Typed details for `StepFailureError`.
 *
 * Covers the fields attached by the executors, the claude-cli classifier, and
 * the prompt-executor's generic wrapper. All fields are optional — not every
 * throw site carries every signal.
 */
export interface StepFailureDetails extends Record<string, unknown> {
  /** Process exit code for script/branch steps. */
  exitCode?: number;
  /** Captured stderr tail when the step ran a subprocess. */
  stderr?: string;
  /** Underlying thrown value — preserved so the CLI can surface detail. */
  cause?: unknown;
  /** Errno string (e.g. `ENOENT`) when the cause was a filesystem error. */
  code?: string | undefined;
  /** Provider name that emitted the failure for claude-cli classifications. */
  providerName?: string;
  /** Sub-classifier code from the claude-cli classifier. */
  errorCode?: string;
  /** URL for users to report unexpected failures. */
  reportUrl?: string;
  /** Per-branch failure summary for parallel steps. */
  branchFailures?: Array<{ branch: string; message: string }>;
  /**
   * Run id of the enclosing run, attached by the orchestrator so CLI
   * remediation hints (`relay logs <runId>`, `relay resume <runId>`) can
   * reference the concrete run instead of a `<runId>` placeholder.
   */
  runId?: string;
}

/**
 * Thrown when a step exits non-zero or throws an unhandled error after all
 * retry attempts are exhausted.
 *
 * CLI exit code: 1
 */
export class StepFailureError extends PipelineError<StepFailureDetails> {
  readonly stepId: string;
  readonly attempt: number;

  constructor(message: string, stepId: string, attempt: number, details?: StepFailureDetails) {
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
 * Typed details for `ClaudeAuthError`.
 *
 * Describes what the auth inspector saw in the environment so the CLI can
 * render a precise remediation without re-parsing the error message.
 */
export interface ClaudeAuthDetails extends Record<string, unknown> {
  /** Env var names that were observed to be set when the guard fired. */
  envObserved?: string[];
  /** Billing source expected by the configuration (`subscription` etc.). */
  billingSource?: string;
  /** Underlying cause when the probe failed (spawn error, etc.). */
  cause?: unknown;
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
export class ClaudeAuthError extends PipelineError<ClaudeAuthDetails> {
  constructor(
    message: string,
    details?: ClaudeAuthDetails,
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
 * Typed details for `HandoffSchemaError`.
 *
 * The issues array is already a constructor parameter; `details` carries any
 * supplemental context the caller wants to preserve (currently unused by the
 * runtime, but the CLI reads `runId`, `stepName`, and `promptFile` when
 * present).
 */
export interface HandoffSchemaDetails extends Record<string, unknown> {
  /** Run id for CLI-side remediation hints. */
  runId?: string;
  /** Step name for prompt-file lookup. */
  stepName?: string;
  /** Path to the prompt template file. */
  promptFile?: string;
}

/**
 * Thrown when a handoff file fails Zod schema validation on read or write.
 *
 * CLI exit code: 4
 */
export class HandoffSchemaError extends PipelineError<HandoffSchemaDetails> {
  readonly handoffId: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(
    message: string,
    handoffId: string,
    issues: z.core.$ZodIssue[],
    details?: HandoffSchemaDetails,
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
 * Typed details for `HandoffIoError`.
 *
 * Captures filesystem cause text, Node errno, and the listing directory for
 * `list()` failures that are not tied to a single handoff id.
 */
export interface HandoffIoDetails extends Record<string, unknown> {
  /** Underlying cause message. */
  cause?: unknown;
  /** Node errno string (`ENOENT`, `EACCES`, etc.). */
  errno?: string;
  /** Directory path for `list()` failures. */
  dir?: string;
}

/**
 * Raised during handoff read or list operations when the underlying filesystem
 * call fails for a reason other than ENOENT or a schema validation failure.
 */
export class HandoffIoError extends PipelineError<HandoffIoDetails> {
  readonly handoffId: string | undefined;

  constructor(message: string, handoffId: string | undefined, details?: HandoffIoDetails) {
    super(message, ERROR_CODES.HANDOFF_IO, details);
    this.name = 'HandoffIoError';
    this.handoffId = handoffId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `HandoffNotFoundError`.
 *
 * Currently unused at throw sites — kept as a structural placeholder so the
 * error class shares the generic parameterisation with its peers.
 */
export interface HandoffNotFoundDetails extends Record<string, unknown> {
  /** Directory searched for the missing handoff. */
  dir?: string;
}

/**
 * Raised when a handoff file is expected to exist but is absent on disk.
 */
export class HandoffNotFoundError extends PipelineError<HandoffNotFoundDetails> {
  readonly handoffId: string;

  constructor(message: string, handoffId: string, details?: HandoffNotFoundDetails) {
    super(message, ERROR_CODES.HANDOFF_NOT_FOUND, details);
    this.name = 'HandoffNotFoundError';
    this.handoffId = handoffId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `HandoffWriteError`.
 *
 * Wraps the underlying atomic-write failure so the CLI can render errno and
 * the target path without re-parsing the message.
 */
export interface HandoffWriteDetails extends Record<string, unknown> {
  /** Underlying `AtomicWriteError` or other cause. */
  cause?: unknown;
  /** Node errno string. */
  errno?: string;
  /** Target path of the write that failed. */
  path?: string;
}

/**
 * Raised when a handoff write (atomic or otherwise) fails with a filesystem error.
 */
export class HandoffWriteError extends PipelineError<HandoffWriteDetails> {
  readonly handoffId: string;

  constructor(message: string, handoffId: string, details?: HandoffWriteDetails) {
    super(message, ERROR_CODES.HANDOFF_WRITE, details);
    this.name = 'HandoffWriteError';
    this.handoffId = handoffId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `MetricsWriteError`.
 *
 * Mirrors the atomic-write context so `doctor` can surface errno and path.
 */
export interface MetricsWriteDetails extends Record<string, unknown> {
  /** Underlying `AtomicWriteError` or other cause. */
  cause?: unknown;
  /** Node errno string. */
  errno?: string;
  /** Path to metrics.json on the failed write. */
  path?: string;
}

/**
 * Raised when CostTracker fails to persist metrics.json via an atomic write.
 */
export class MetricsWriteError extends PipelineError<MetricsWriteDetails> {
  constructor(message: string, details?: MetricsWriteDetails) {
    super(message, ERROR_CODES.METRICS_WRITE, details);
    this.name = 'MetricsWriteError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `StateCorruptError`.
 *
 * Records the parse reason and the underlying cause so the resume path can
 * distinguish a malformed state.json from a malformed flow-ref.json and show
 * the relevant file contents to the operator.
 */
export interface StateCorruptDetails extends Record<string, unknown> {
  /** Human-readable parse or validation reason. */
  reason?: string;
  /** Underlying thrown value or zod issue list. */
  cause?: unknown;
  /** Path of the corrupt file when helpful for disambiguation. */
  path?: string;
}

/**
 * Raised when state.json exists but cannot be parsed or does not match the
 * expected shape. Indicates a corrupt or manually-edited state file.
 */
export class StateCorruptError extends PipelineError<StateCorruptDetails> {
  constructor(message: string, details?: StateCorruptDetails) {
    super(message, ERROR_CODES.STATE_CORRUPT, details);
    this.name = 'StateCorruptError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `StateNotFoundError`.
 *
 * Currently no additional fields are attached at throw sites; retained for
 * callers that want to annotate the absence with context (e.g. expected
 * filename) without breaking the base-class index signature.
 */
export interface StateNotFoundDetails extends Record<string, unknown> {
  /** Filename the caller expected to find inside `runDir`. */
  expectedFile?: string;
}

/**
 * Raised when state.json is absent in the run directory, indicating a fresh run
 * rather than a resumable one.
 */
export class StateNotFoundError extends PipelineError<StateNotFoundDetails> {
  readonly runDir: string;

  constructor(message: string, runDir: string, details?: StateNotFoundDetails) {
    super(message, ERROR_CODES.STATE_NOT_FOUND, details);
    this.name = 'StateNotFoundError';
    this.runDir = runDir;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `StateTransitionError`.
 *
 * Captures the attempted operation and the status the machine refused to
 * transition from. Tests assert against these fields directly.
 */
export interface StateTransitionDetails extends Record<string, unknown> {
  /** Status the step was already in when the transition was attempted. */
  from?: string;
  /** Name of the attempted operation — `start`, `complete`, `fail`, etc. */
  attempted?: string;
}

/**
 * Raised when the StateMachine is asked to apply an illegal transition or
 * references a step id that does not exist in the loaded flow.
 */
export class StateTransitionError extends PipelineError<StateTransitionDetails> {
  readonly stepId: string | undefined;

  constructor(message: string, stepId: string | undefined, details?: StateTransitionDetails) {
    super(message, ERROR_CODES.STATE_TRANSITION, details);
    this.name = 'StateTransitionError';
    this.stepId = stepId;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `StateVersionMismatchError`. Expected and actual pairs are
 * already carried as own properties of the error; `details` is reserved for
 * any supplemental context callers want to preserve.
 */
export interface StateVersionMismatchDetails extends Record<string, unknown> {
  /** Run directory where the mismatch was detected. */
  runDir?: string;
}

/**
 * Raised when persisted state was written by a different flow name or version
 * than the one currently loaded, making safe resumption impossible.
 */
export class StateVersionMismatchError extends PipelineError<StateVersionMismatchDetails> {
  readonly expected: { flowName: string; flowVersion: string };
  readonly actual: { flowName: string; flowVersion: string };

  constructor(
    message: string,
    expected: { flowName: string; flowVersion: string },
    actual: { flowName: string; flowVersion: string },
    details?: StateVersionMismatchDetails,
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
 * Typed details for `StateWriteError`.
 *
 * Mirrors the atomic-write context so operators can diagnose disk/permission
 * failures without re-parsing the message.
 */
export interface StateWriteDetails extends Record<string, unknown> {
  /** Underlying `AtomicWriteError` or other cause. */
  cause?: unknown;
  /** Node errno string. */
  errno?: string;
  /** Target state.json path on the failed write. */
  path?: string;
}

/**
 * Raised when StateMachine fails to persist state.json via an atomic write.
 */
export class StateWriteError extends PipelineError<StateWriteDetails> {
  constructor(message: string, details?: StateWriteDetails) {
    super(message, ERROR_CODES.STATE_WRITE, details);
    this.name = 'StateWriteError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `TimeoutError`.
 *
 * The CLI reads `runId` and `artifactPath` when formatting remediation lines;
 * neither is populated at the current throw sites but both are reserved so
 * future callers can attach them without a breaking signature change.
 */
export interface TimeoutDetails extends Record<string, unknown> {
  /** Run id for CLI remediation hints. */
  runId?: string;
  /** Path to a partial artifact captured before the timeout fired. */
  artifactPath?: string;
}

/**
 * Thrown when a step exceeds its configured `timeoutMs` budget.
 *
 * CLI exit code: 5
 */
export class TimeoutError extends PipelineError<TimeoutDetails> {
  readonly stepId: string;
  readonly timeoutMs: number;

  constructor(
    message: string,
    stepId: string,
    timeoutMs: number,
    details?: TimeoutDetails,
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
 * configured `authTimeoutMs` budget. The Orchestrator enforces this before any
 * step executes so a misconfigured CLI probe or a buggy custom provider cannot hang
 * the run indefinitely with no observable progress.
 *
 * Carries `providerName` rather than a step id — auth runs before the DAG
 * walker, so no step is in flight when this fires.
 *
 * CLI exit code: 5 (shares the timeout exit code with `TimeoutError`).
 */
export class AuthTimeoutError extends TimeoutError {
  readonly providerName: string;

  constructor(message: string, providerName: string, timeoutMs: number, details?: TimeoutDetails) {
    super(message, '', timeoutMs, details, ERROR_CODES.AUTH_TIMEOUT);
    this.name = 'AuthTimeoutError';
    this.providerName = providerName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `ProviderAuthError`.
 *
 * The claude-cli classifier attaches `stepId` and `attempt` when mapping a
 * subprocess auth exit; other call sites leave the details undefined.
 */
export interface ProviderAuthDetails extends Record<string, unknown> {
  /** Step id when the failure surfaced inside a prompt invocation. */
  stepId?: string;
  /** Attempt number when the failure surfaced inside a prompt invocation. */
  attempt?: number;
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
export class ProviderAuthError extends PipelineError<ProviderAuthDetails> {
  readonly providerName: string;

  constructor(message: string, providerName: string, details?: ProviderAuthDetails) {
    super(message, ERROR_CODES.PROVIDER_AUTH, details);
    this.name = 'ProviderAuthError';
    this.providerName = providerName;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Typed details for `AtomicWriteError`.
 *
 * Preserves the underlying cause text alongside the errno/path that are
 * already carried as own properties.
 */
export interface AtomicWriteDetails extends Record<string, unknown> {
  /** Underlying error message captured at the failure boundary. */
  cause?: string;
}

/**
 * Thrown (via Result.err) when atomicWriteText / atomicWriteJson fails
 * irrecoverably. Carries the underlying Node errno (EXDEV, EACCES, etc.)
 * so callers can discriminate transient-vs-terminal cases.
 * Maps to CLI exit code 7 (I/O error).
 */
export class AtomicWriteError extends PipelineError<AtomicWriteDetails> {
  readonly path: string;
  readonly errno: string | undefined;

  constructor(
    message: string,
    path: string,
    errno: string | undefined,
    details?: AtomicWriteDetails,
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
 * Typed details for `NoProviderConfiguredError`.
 *
 * No constructor call currently populates this, but the shape is reserved so
 * future callers can record the provider-selection search path without a
 * breaking signature change.
 */
export interface NoProviderConfiguredDetails extends Record<string, unknown> {
  /** Paths consulted when selecting a provider (flow settings, global settings). */
  searchedPaths?: string[];
}

/**
 * Raised when no provider is configured — neither a CLI flag, nor a flow-level
 * settings.json, nor a global settings.json carries a `provider` value.
 *
 * CLI exit code: 6 (no provider configured — the run cannot proceed before
 * any tokens are spent).
 */
export class NoProviderConfiguredError extends PipelineError<NoProviderConfiguredDetails> {
  constructor(details?: NoProviderConfiguredDetails) {
    super(
      'no provider configured. run `relay init` to pick one, or pass `--provider claude-cli`.',
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
 * Typed details for `ProviderCapabilityError`.
 *
 * Every capability-check branch attaches the step id and provider name; some
 * attach additional per-check context (requested vs supported lists).
 */
export interface ProviderCapabilityDetails extends Record<string, unknown> {
  /** Step id whose configuration exceeded the provider's capabilities. */
  stepId?: string;
  /** Provider name (repeats the own-property value for structured logs). */
  providerName?: string;
  /** Tools requested by the step for tool-capability failures. */
  requestedTools?: readonly string[];
  /** Tools missing from the provider's advertised list. */
  missingTools?: readonly string[];
  /** Tools the provider advertises, for remediation messages. */
  supportedTools?: readonly string[];
  /** Model requested by the step for model-capability failures. */
  requestedModel?: string;
  /** Models the provider advertises, for remediation messages. */
  supportedModels?: readonly string[];
  /** Budget cap requested by the step for budgetCap failures. */
  requestedBudget?: number;
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
    details?: ProviderCapabilityDetails,
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
 * Typed details for `ProviderRateLimitError`.
 *
 * The rate-limit throw sites currently pass no details — the original cause is
 * preserved on `retryAfterMs` and the own properties; this interface is
 * reserved so the retry layer can attach structured hints later.
 */
export interface ProviderRateLimitDetails extends Record<string, unknown> {
  /** Original thrown value from the SDK or subprocess classifier. */
  cause?: unknown;
}

/**
 * Thrown when a provider reports a rate-limit response (HTTP 429 or a typed
 * rate-limit error from the underlying SDK). Distinct from `StepFailureError`
 * so the retry layer can apply a longer backoff base, and from `TimeoutError`
 * so retries are not short-circuited for a recoverable rate-limit condition.
 *
 * The original thrown value is preserved at `details.cause`.
 *
 * CLI exit code: 8 (rate_limit).
 */
export class ProviderRateLimitError extends PipelineError<ProviderRateLimitDetails> {
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
    details?: ProviderRateLimitDetails,
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
