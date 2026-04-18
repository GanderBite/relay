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

export type { ErrorCode } from './errors.js';
// Error hierarchy
export {
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffSchemaError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  StepFailureError,
  TimeoutError,
  toFlowDefError,
} from './errors.js';
// Flow compiler
export { defineFlow } from './flow/define.js';
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
// Logger — exports both the pino instance (value) and its type
export { Logger } from './logger.js';
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
// Atomic write helpers
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';
// Zod re-export — consumers reach for z.ZodType<T>, z.core.$ZodIssue, z.infer<typeof X> directly
export { z } from './zod.js';
