// @relay/core -- library entry.

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
// Baton persistence
export { BatonStore } from './batons.js';
// Constants
export { GITHUB_ISSUES_URL, GITHUB_URL } from './constants.js';
export type { AssemblePromptArgs } from './context-inject.js';
// Context injection
export { assemblePrompt, loadBatonValues } from './context-inject.js';
export type { CostSummary, RunnerMetrics } from './cost.js';
// Cost tracking
export { CostTracker } from './cost.js';
export type { ErrorCode } from './errors.js';
// Error hierarchy
export {
  AtomicWriteError,
  AuthTimeoutError,
  BatonIoError,
  BatonNotFoundError,
  BatonSchemaError,
  BatonWriteError,
  ClaudeAuthError,
  ERROR_CODES,
  MetricsWriteError,
  NoProviderConfiguredError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  RaceDefinitionError,
  RaceStateCorruptError,
  RaceStateNotFoundError,
  RaceStateTransitionError,
  RaceStateVersionMismatchError,
  RaceStateWriteError,
  RunnerFailureError,
  TimeoutError,
  toRaceDefError,
} from './errors.js';
export type { CreateLoggerOptions, LogEvent, Logger } from './logger.js';
// Logger — factory that returns a scoped pino instance with raceName/runId bindings.
export { CONSOLE_COLOR_DISABLED, createLogger, stripAnsi } from './logger.js';
export type {
  OrchestratorOptions,
  RunnerExecutionContext,
  RunnerResult,
  RunOptions,
  RunResult,
} from './orchestrator/index.js';
// Orchestrator — orchestrates race execution
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
// Race compiler
export { defineRace } from './race/define.js';
// Runner namespace and runner spec types
export { runner } from './race/runner.js';
// Race and runner core types
export type {
  BranchRunnerSpec,
  ParallelRunnerSpec,
  PromptRunnerOutput,
  PromptRunnerSpec,
  Race,
  RaceGraph,
  RaceSpec,
  RaceState,
  RaceStatus,
  Runner,
  RunnerBase,
  RunnerKind,
  RunnerState,
  RunnerStatus,
  ScriptRunnerSpec,
  TerminalRunnerSpec,
} from './race/types.js';
export type { RelaySettingsType, ResolveProviderArgs } from './settings/index.js';
// Settings — provider selection and path resolution
export {
  globalSettingsPath,
  loadGlobalSettings,
  loadRaceSettings,
  RelaySettings,
  raceSettingsPath,
  resolveProvider,
} from './settings/index.js';
// Run state persistence
export { loadState, RaceStateMachine, verifyCompatibility } from './state.js';
// Atomic write helpers
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';
// Zod re-export — consumers reach for z.ZodType<T>, z.core.$ZodIssue, z.infer<typeof X> directly
export { z } from './zod.js';
