// @relay/core -- library entry.

// Context injection
export { assemblePrompt, loadHandoffValues } from './context-inject.js';
export type { AssemblePromptArgs } from './context-inject.js';

// Cost tracking
export { CostTracker } from './cost.js';
export type { CostSummary, StepMetrics } from './cost.js';

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
  SubscriptionTosLeakError,
  TimeoutError,
  toFlowDefError,
} from './errors.js';
// Constants
export { GITHUB_ISSUES_URL, GITHUB_URL } from './constants.js';
// Flow compiler
export { defineFlow } from './flow/define.js';
// Handoff persistence
export { HandoffStore } from './handoffs.js';
// Step namespace and step spec types
export { step } from './flow/step.js';
// Flow and step core types
export type {
  BranchStepSpec,
  Flow,
  FlowGraph,
  FlowSpec,
  ParallelStepSpec,
  PromptStepOutput,
  PromptStepSpec,
  RunState,
  RunStatus,
  ScriptStepSpec,
  Step,
  StepBase,
  StepKind,
  StepState,
  StepStatus,
  TerminalStepSpec,
} from './flow/types.js';
// Logger — factory that returns a scoped pino instance with flowName/runId bindings.
export { createLogger } from './logger.js';
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
export { StateMachine, loadState, verifyCompatibility } from './state.js';
// Atomic write helpers
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';
// Zod re-export — consumers reach for z.ZodType<T>, z.core.$ZodIssue, z.infer<typeof X> directly
export { z } from './zod.js';

// ClaudeProvider
export { ClaudeProvider, registerDefaultProviders } from './providers/claude/index.js';
export type { ClaudeProviderOptions } from './providers/claude/index.js';

// Runner — orchestrates flow execution
export { createRunner, Runner } from './runner/index.js';
export type {
  RunnerOptions,
  RunOptions,
  RunResult,
  StepExecutionContext,
  StepResult,
} from './runner/index.js';
