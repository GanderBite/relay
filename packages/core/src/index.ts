// @relay/core -- library entry.

// Result types — use these to handle errors returned by defineFlow, step.*, atomicWrite*
export {
  err,
  errAsync,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from 'neverthrow';

/** Stable string constants — the GitHub repo URL and the issues URL. */
export { GITHUB_ISSUES_URL, GITHUB_URL } from './constants.js';
/** Arguments for `assemblePrompt`. */
/** Union of error types returned by `loadHandoffValues`. */
export type { AssemblePromptArgs, LoadHandoffValuesError } from './context-inject.js';

/**
 * Assembles a prompt string by interpolating handoff values into a template.
 * Call before passing the prompt text to a provider invocation.
 */
export { assemblePrompt, loadHandoffValues } from './context-inject.js';

/** Per-step token and dollar cost metrics recorded by `CostTracker`. */
export type { CostSummary, StepMetrics } from './cost.js';

/**
 * Accumulates per-step cost data during a run and persists totals to
 * `metrics.json` via an atomic write. Summaries are available synchronously
 * via `summary()` after the run completes.
 */
export { CostTracker } from './cost.js';
/** Union of all stable error code strings emitted by `PipelineError` subclasses. */
/** Typed details interfaces for `PipelineError` subclasses. Pattern-match on `error.details` with these types. */
export type {
  AtomicWriteDetails,
  ClaudeAuthDetails,
  ErrorCode,
  FlowDefinitionDetails,
  HandoffIoDetails,
  HandoffNotFoundDetails,
  HandoffSchemaDetails,
  HandoffWriteDetails,
  MetricsWriteDetails,
  NoProviderConfiguredDetails,
  ProviderAuthDetails,
  ProviderCapabilityDetails,
  ProviderRateLimitDetails,
  StateCorruptDetails,
  StateNotFoundDetails,
  StateTransitionDetails,
  StateVersionMismatchDetails,
  StateWriteDetails,
  StepFailureDetails,
  TimeoutDetails,
} from './errors.js';
/**
 * Error classes and helpers for the Relay runtime error hierarchy.
 *
 * - `PipelineError` — base class carrying a stable `code` and optional `details`.
 * - `FlowDefinitionError` — thrown at load time for invalid step references, cycles, or missing providers.
 * - `StepFailureError` — thrown when a step exhausts its retry budget.
 * - `ClaudeAuthError` — thrown when the Claude backend environment is unsafe to spawn (billing safety guard).
 * - `HandoffSchemaError` — thrown when a handoff value fails Zod schema validation.
 * - `HandoffIoError` — thrown when a handoff read or list call fails due to an I/O error.
 * - `HandoffNotFoundError` — thrown when an expected handoff file is absent.
 * - `HandoffWriteError` — thrown when a handoff atomic write fails.
 * - `MetricsWriteError` — thrown when `CostTracker` cannot persist `metrics.json`.
 * - `NoProviderConfiguredError` — thrown when no provider is configured via flag, flow settings, or global settings.
 * - `ProviderAuthError` — thrown by a provider's `authenticate()` when credentials are missing or invalid.
 * - `ProviderCapabilityError` — thrown when a step requests a capability the configured provider does not support.
 * - `ProviderRateLimitError` — thrown when a provider reports a rate-limit response.
 * - `StateCorruptError` — thrown when `state.json` cannot be parsed or does not match the expected shape.
 * - `StateNotFoundError` — thrown when `state.json` is absent in the run directory.
 * - `StateTransitionError` — thrown when the `StateMachine` is asked to apply an illegal transition.
 * - `StateVersionMismatchError` — thrown when persisted state was written by a different flow name or version.
 * - `StateWriteError` — thrown when `StateMachine` cannot persist `state.json`.
 * - `TimeoutError` — thrown when a step exceeds its configured `timeoutMs` budget.
 * - `AuthTimeoutError` — thrown when a provider's `authenticate()` does not settle within `authTimeoutMs`.
 * - `AtomicWriteError` — thrown (via `Result.err`) when an atomic write fails irrecoverably.
 * - `ERROR_CODES` — stable string constants for all error codes.
 * - `toFlowDefError` — wraps a Zod parse error into a `FlowDefinitionError`.
 */
export {
  AtomicWriteError,
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffIoError,
  HandoffNotFoundError,
  HandoffSchemaError,
  HandoffWriteError,
  MetricsWriteError,
  NoProviderConfiguredError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StateCorruptError,
  StateNotFoundError,
  StateTransitionError,
  StateVersionMismatchError,
  StateWriteError,
  StepFailureError,
  TimeoutError,
  toFlowDefError,
} from './errors.js';
/** Input shape accepted by `defineFlow`, and the union of step builder outputs it accepts. */
export type { FlowInput, StepBuilderOutput } from './flow/define.js';
/**
 * Compiles a flow definition into a frozen `Flow` object.
 *
 * Validates the spec against the flow schema, injects `id` fields from record
 * keys, builds the DAG, and detects cycles — all synchronously. Throws
 * `FlowDefinitionError` on any validation failure so problems surface at
 * module load time, before any tokens are spent.
 *
 * @param spec - Flow name, semver version, Zod input schema, and a record of
 *   step builder outputs keyed by step id.
 * @returns A frozen `Flow` that the `Orchestrator` accepts.
 */
export { defineFlow } from './flow/define.js';

/**
 * Namespace of step builder functions. Each builder validates its config
 * against the step schema and throws `FlowDefinitionError` on invalid input.
 *
 * - `step.prompt(config)` — runs a prompt file via a provider.
 *   Key config options: `promptFile` (required), `model`, `contextFrom`,
 *   `output` (required — `{ handoff }`, `{ artifact }`, or both),
 *   `maxRetries` (optional; omitting means no retry), `timeoutMs` (default 600000), `maxBudgetUsd`,
 *   `dependsOn`.
 *
 * - `step.script(config)` — runs a shell command or script.
 *   Key config options: `run` (required — string or string[]), `env`, `cwd`,
 *   `output`, `onExit`, `maxRetries`, `timeoutMs`, `dependsOn`.
 *
 * - `step.branch(config)` — runs a script and routes control based on exit code.
 *   Key config options: `run` (required), `onExit` (required, non-empty map),
 *   `env`, `cwd`, `maxRetries`, `timeoutMs`, `dependsOn`.
 *
 * - `step.parallel(config)` — fans out to named sub-steps and waits for all.
 *   Key config options: `branches` (required, non-empty array of step ids),
 *   `onAllComplete`, `onFail`, `dependsOn`. Does not support retry, timeout,
 *   or `contextFrom`.
 *
 * - `step.terminal(config)` — ends the flow with an optional message and exit code.
 *   Key config options: `message`, `exitCode`, `dependsOn`.
 */
export { step } from './flow/step.js';

/** Builder input and output shapes for each step kind. Useful for typing custom step wrappers. */
export type { BranchStepBuilderInput, BranchStepBuilderOutput } from './flow/steps/branch.js';
export type {
  ParallelStepBuilderInput,
  ParallelStepBuilderOutput,
} from './flow/steps/parallel.js';
export type { PromptStepBuilderInput, PromptStepBuilderOutput } from './flow/steps/prompt.js';
export type { ScriptStepBuilderInput, ScriptStepBuilderOutput } from './flow/steps/script.js';
export type {
  TerminalStepBuilderInput,
  TerminalStepBuilderOutput,
} from './flow/steps/terminal.js';

/**
 * Core flow and step type exports.
 *
 * - `Flow` — compiled flow returned by `defineFlow`.
 * - `FlowGraph` — DAG representation with successor/predecessor maps and topological order.
 * - `FlowSpec` — the raw spec shape before compilation.
 * - `FlowStatus` — `'running' | 'succeeded' | 'failed' | 'aborted'`.
 * - `Step` — discriminated union of all compiled step types.
 * - `StepBase` — fields shared by every step (`id`, `dependsOn`).
 * - `StepKind` — `'prompt' | 'script' | 'branch' | 'parallel' | 'terminal'`.
 * - `StepState` — per-step checkpoint state persisted in `state.json`.
 * - `StepStatus` — `'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'`.
 * - `PromptStepSpec` — spec for a step that invokes a Claude prompt.
 * - `PromptStepOutput` — output routing shape for prompt steps.
 * - `ScriptStepSpec` — spec for a step that runs a shell command.
 * - `BranchStepSpec` — spec for a step that routes control by exit code.
 * - `ParallelStepSpec` — spec for a step that fans out to named sub-steps.
 * - `TerminalStepSpec` — spec for a step that ends the flow.
 * - `RunState` — full run checkpoint persisted to `state.json`.
 */
export type {
  BranchStep,
  BranchStepSpec,
  Flow,
  FlowGraph,
  FlowSpec,
  FlowStatus,
  ParallelStep,
  ParallelStepSpec,
  PromptStep,
  PromptStepOutput,
  PromptStepSpec,
  RunState,
  ScriptStep,
  ScriptStepSpec,
  Step,
  StepBase,
  StepKind,
  StepState,
  StepStatus,
  TerminalStep,
  TerminalStepSpec,
} from './flow/types.js';
/** Union of error types returned by `HandoffStore.write`. */
export type { WriteError } from './handoffs.js';
/**
 * Reads and writes handoff JSON files under `<runDir>/handoffs/`.
 *
 * `write(id, value, schema?)` persists atomically and serializes concurrent
 * writes for the same id. `read(id, schema?)` validates against a Zod schema
 * when provided. `list()` returns sorted ids present on disk.
 * Returns `Result` on every fallible operation — never throws.
 */
export { HandoffStore } from './handoffs.js';

/** Options for `createLogger` and the logger event shape. */
export type { CreateLoggerOptions, LogEvent, Logger } from './logger.js';

/**
 * Logger factory that returns a scoped pino instance bound to `flowName`
 * and `runId`. `CONSOLE_COLOR_DISABLED` is a boolean constant resolved at
 * module load from `NO_COLOR` / TTY / settings-file color preference. Read
 * it to decide whether to emit ANSI escapes in adjacent consumer code.
 * `stripAnsi` removes ANSI escape sequences from a string.
 */
export { CONSOLE_COLOR_DISABLED, createLogger, stripAnsi } from './logger.js';

/** Type exports for the `Orchestrator` and its run options. */
export type {
  BranchStepResult,
  OrchestratorOptions,
  ParallelStepResult,
  PromptStepResult,
  RunOptions,
  RunResult,
  ScriptStepResult,
  StepExecutionContext,
  StepResult,
  TerminalStepResult,
} from './orchestrator/index.js';

/**
 * `Orchestrator` drives the execution of a compiled `Flow`.
 *
 * `createOrchestrator(opts?)` is the preferred factory. A single instance may
 * serve multiple sequential `run()` calls; concurrent calls are not supported.
 *
 * `run(flow, input, opts?)` starts a fresh run and resolves to `RunResult`.
 * `resume(runDir, opts?)` continues a previously failed or aborted run from
 * its persisted checkpoint.
 */
export { createOrchestrator, Orchestrator } from './orchestrator/index.js';

/** Options for constructing a `ClaudeCliProvider`. */
export type { ClaudeCliProviderOptions } from './providers/claude-cli/index.js';

/**
 * Provider that runs `claude -p` as a managed subprocess.
 * Enforces the subscription-billing safety contract — rejects runs when
 * `ANTHROPIC_API_KEY` is present without an explicit opt-in.
 */
export { ClaudeCliProvider } from './providers/claude-cli/index.js';

/**
 * Registers the `claude-cli` backend in the default registry, idempotently.
 * Call once at startup when using the default provider selection path.
 */
export { registerDefaultProviders } from './providers/index.js';

/**
 * `ProviderRegistry` maps provider names to `Provider` instances.
 * `defaultRegistry` is the singleton used by `Orchestrator` when no custom
 * registry is passed via `OrchestratorOptions`.
 */
export { defaultRegistry, ProviderRegistry } from './providers/registry.js';

/** Provider interface and invocation type exports. */
export type {
  AuthState,
  CostEstimate,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
  ProviderCapabilities,
} from './providers/types.js';

/** Type for the validated settings object and the `resolveProvider` argument shape. */
export type { RelaySettingsType, ResolveProviderArgs } from './settings/index.js';

/**
 * Settings helpers for provider selection.
 *
 * - `globalSettingsPath()` — returns `~/.relay/settings.json`.
 * - `flowSettingsPath(flowDir)` — returns `<flowDir>/settings.json`.
 * - `loadGlobalSettings()` — reads and validates the global settings file.
 * - `loadFlowSettings(flowDir)` — reads and validates the flow-level settings file.
 * - `resolveProvider(args)` — resolves a provider name from flag → flow settings → global settings,
 *   returning `NoProviderConfiguredError` when none is found.
 * - `RelaySettings` — Zod schema for the settings file shape.
 */
export {
  flowSettingsPath,
  globalSettingsPath,
  loadFlowSettings,
  loadGlobalSettings,
  RelaySettings,
  resolveProvider,
} from './settings/index.js';

/**
 * State persistence helpers.
 *
 * - `loadState(runDir)` — reads and validates `state.json` from a run directory.
 * - `StateMachine` — manages step-level state transitions and atomic persistence.
 * - `verifyCompatibility(state, flow)` — checks that persisted state matches the
 *   current flow name and version before a resume.
 */
export { loadState, StateMachine, verifyCompatibility } from './state.js';

/**
 * `atomicWriteJson(path, value)` serializes `value` to JSON and writes it via
 * a temp-file rename so readers never observe a partial file.
 * `atomicWriteText(path, text)` does the same for a plain string.
 * Both return `Result<void, AtomicWriteError>`.
 */
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';

/** Zod re-export — consumers reach for `z.ZodType<T>`, `z.core.$ZodIssue`, `z.infer<typeof X>` directly. */
export { z } from './zod.js';
