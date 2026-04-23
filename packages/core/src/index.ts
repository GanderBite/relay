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
// Constants
export { GITHUB_ISSUES_URL, GITHUB_URL } from './constants.js';
export type { AssemblePromptArgs } from './context-inject.js';
// Context injection
export { assemblePrompt, loadHandoffValues } from './context-inject.js';
export type { CostSummary, StepMetrics } from './cost.js';
// Cost tracking
export { CostTracker } from './cost.js';
export type { ErrorCode } from './errors.js';
// Error hierarchy
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
// Flow compiler
export { defineFlow } from './flow/define.js';
// Step factory namespace and step spec types
export { step } from './flow/step.js';
// Flow and step core types
export type {
  BranchStepSpec,
  Flow,
  FlowGraph,
  FlowSpec,
  FlowStatus,
  ParallelStepSpec,
  PromptStepOutput,
  PromptStepSpec,
  RunState,
  ScriptStepSpec,
  Step,
  StepBase,
  StepKind,
  StepState,
  StepStatus,
  TerminalStepSpec,
} from './flow/types.js';
// Handoff persistence
export { HandoffStore } from './handoffs.js';
export type { CreateLoggerOptions, LogEvent, Logger } from './logger.js';
// Logger — factory that returns a scoped pino instance with flowName/runId bindings.
export { CONSOLE_COLOR_DISABLED, createLogger, stripAnsi } from './logger.js';
export type {
  OrchestratorOptions,
  RunOptions,
  RunResult,
  StepExecutionContext,
  StepResult,
} from './orchestrator/index.js';
// Orchestrator — orchestrates flow execution
export { createOrchestrator, Orchestrator } from './orchestrator/index.js';
export type { ClaudeCliProviderOptions } from './providers/claude-cli/index.js';
// ClaudeCliProvider
export { ClaudeCliProvider } from './providers/claude-cli/index.js';
// Default provider registration — registers the claude-cli backend idempotently.
export { registerDefaultProviders } from './providers/index.js';
// Provider registry
export { defaultRegistry, ProviderRegistry } from './providers/registry.js';
// Provider and invocation types
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
export type { RelaySettingsType, ResolveProviderArgs } from './settings/index.js';
// Settings — provider selection and path resolution
export {
  flowSettingsPath,
  globalSettingsPath,
  loadFlowSettings,
  loadGlobalSettings,
  RelaySettings,
  resolveProvider,
} from './settings/index.js';
// Run state persistence
export { loadState, StateMachine, verifyCompatibility } from './state.js';
// Atomic write helpers
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';
// Zod re-export — consumers reach for z.ZodType<T>, z.core.$ZodIssue, z.infer<typeof X> directly
export { z } from './zod.js';
