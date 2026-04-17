// @relay/core -- library entry.

// Error hierarchy (task_6)
export {
  ERROR_CODES,
  PipelineError,
  FlowDefinitionError,
  StepFailureError,
  ClaudeAuthError,
  HandoffSchemaError,
  TimeoutError,
  ProviderAuthError,
  ProviderCapabilityError,
} from './errors.js';
export type { ErrorCode } from './errors.js';

// Atomic write helpers (task_7)
export { atomicWriteJson, atomicWriteText } from './util/atomic-write.js';

// Logger (task_8)
export { Logger } from './logger.js';
export type { LogLevel, LogEvent, LoggerOptions } from './logger.js';

// Zod re-export (task_9)
export { z } from './zod.js';
export type { ZodSchema, ZodIssue, ZodTypeAny, Infer } from './zod.js';

// Provider and invocation types (task_10)
export type {
  Provider,
  ProviderCapabilities,
  AuthState,
  NormalizedUsage,
  InvocationRequest,
  InvocationContext,
  InvocationResponse,
  InvocationEvent,
  CostEstimate,
} from './providers/types.js';
