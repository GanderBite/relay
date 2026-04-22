// @relay/core -- library entry.

// Context injection
export { assemblePrompt, loadBatonValues } from './context-inject.js';
export type { AssemblePromptArgs } from './context-inject.js';

// Cost tracking
export { CostTracker } from './cost.js';
export type { CostSummary, RunnerMetrics } from './cost.js';

// Result types — use these to handle errors returned by defineRace, runner.*, atomicWrite*
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

export type { ErrorCode } from './errors.js';
// Error hierarchy
export {
  AtomicWriteError,
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  RaceDefinitionError,
  BatonIoError,
  BatonNotFoundError,
  BatonSchemaError,
  BatonWriteError,
  MetricsWriteError,
  NoProviderConfiguredError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  RaceStateCorruptError,
  RaceStateNotFoundError,
  RaceStateTransitionError,
  RaceStateVersionMismatchError,
  RaceStateWriteError,
  StepFailureError,
  SubscriptionTosLeakError,
  TimeoutError,
  toRaceDefError,
} from './errors.js';
// Constants
export { GITHUB_ISSUES_URL, GITHUB_URL } from './constants.js';
// Race compiler
export { defineRace } from './race/define.js';
// Baton persistence
export { BatonStore } from './batons.js';
// Runner namespace and runner spec types
export { runner } from './race/runner.js';
// Race and runner core types
export type {
  BranchRunnerSpec,
  Race,
  RaceGraph,
  RaceSpec,
  ParallelRunnerSpec,
  PromptRunnerOutput,
  PromptRunnerSpec,
  RaceState,
  RaceStatus,
  ScriptRunnerSpec,
  Runner,
  RunnerBase,
  RunnerKind,
  RunnerState,
  RunnerStatus,
  TerminalRunnerSpec,
} from './race/types.js';
// Logger — factory that returns a scoped pino instance with raceName/runId bindings.
export { CONSOLE_COLOR_DISABLED, createLogger, stripAnsi } from './logger.js';
export type { CreateLoggerOptions, LogEvent, Logger } from './logger.js';
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
// Run state persistence
export { RaceStateMachine, loadState, verifyCompatibility } from './state.js';
// Atomic write helpers
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';
// Zod re-export — consumers reach for z.ZodType<T>, z.core.$ZodIssue, z.infer<typeof X> directly
export { z } from './zod.js';

// ClaudeAgentSdkProvider
export { ClaudeAgentSdkProvider } from './providers/claude/index.js';
export type { ClaudeAgentSdkProviderOptions } from './providers/claude/index.js';

// Default provider registration — registers both Claude backends idempotently.
export { registerDefaultProviders } from './providers/index.js';

// ClaudeCliProvider
export { ClaudeCliProvider } from './providers/claude-cli/index.js';
export type { ClaudeCliProviderOptions } from './providers/claude-cli/index.js';

// Orchestrator — orchestrates race execution
export { createOrchestrator, Orchestrator } from './orchestrator/index.js';
export type {
  OrchestratorOptions,
  RunOptions,
  RunResult,
  RunnerExecutionContext,
  RunnerResult,
} from './orchestrator/index.js';

// Settings — provider selection and path resolution
export {
  loadRaceSettings,
  loadGlobalSettings,
  raceSettingsPath,
  globalSettingsPath,
  resolveProvider,
  RelaySettings,
} from './settings/index.js';
export type { ResolveProviderArgs, RelaySettingsType } from './settings/index.js';
