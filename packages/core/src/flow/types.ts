import type { z } from '../zod.js';
import type { DynamicQuestionSource, Question } from './question.js';

export type StepKind = 'prompt' | 'script' | 'branch' | 'parallel' | 'terminal' | 'loop' | 'ask';

export type ScriptEnvResolve = 'fromCwd' | 'absolute';

export interface ScriptEnvFromSpec {
  from: string;
  required?: boolean | undefined;
  resolve?: ScriptEnvResolve | undefined;
}

export type ScriptEnvValueSpec = string | ScriptEnvFromSpec;

/**
 * Type guard that narrows a `ScriptEnvValueSpec` to `ScriptEnvFromSpec`.
 * Used by the runtime resolver and the builder validation loop to distinguish
 * dynamic from-path references from static string literals.
 */
export function isScriptEnvFromSpec(v: ScriptEnvValueSpec): v is ScriptEnvFromSpec {
  return typeof v === 'object';
}

/**
 * The minimum fields shared by every step type.
 * Each per-kind spec explicitly opts in to the additional fields (retry,
 * timeout, contextFrom, onFail, etc.) that apply to it — nothing is silently
 * inherited here.
 */
export interface StepBase {
  /** The step's stable identifier. Set by the flow compiler, not the builder. */
  id: string;
  /** Ids of steps that must succeed before this one runs. */
  dependsOn?: string[] | undefined;
}

export type PromptStepOutput =
  | { handoff: string; schema?: z.ZodType | undefined }
  | { artifact: string }
  | { handoff: string; artifact: string; schema?: z.ZodType | undefined };

/**
 * Condition that terminates a loop iteration cycle. The `from` field names
 * the step whose output is inspected, and `when` is a shallow-equality
 * pattern matched against that output.
 */
export interface LoopUntilCondition {
  from: string;
  when: Record<string, unknown>;
}

/**
 * Specification for a step that invokes a Claude prompt via a provider.
 * Supports retry, timeout, budget cap, context injection, and structured
 * output routing (handoff and/or artifact).
 */
export interface PromptStepSpec extends StepBase {
  kind: 'prompt';
  promptFile: string;
  model?: string | undefined;
  tools?: string[] | undefined;
  systemPrompt?: string | undefined;
  contextFrom?: string[] | undefined;
  output: PromptStepOutput;
  maxRetries?: number | undefined;
  maxBudgetUsd?: number | undefined;
  timeoutMs?: number | undefined;
  onFail?: 'abort' | 'continue' | string | undefined;
}

/**
 * Specification for a step that runs a shell command or script.
 * Supports retry, timeout, exit-code routing, and optional artifact output.
 */
export interface ScriptStepSpec extends StepBase {
  kind: 'script';
  run: string | string[];
  env?: Record<string, ScriptEnvValueSpec> | undefined;
  cwd?: string | undefined;
  output?: { artifact?: string | undefined } | undefined;
  onExit?: Record<string, 'abort' | 'continue' | string> | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  onFail?: 'abort' | 'continue' | string | undefined;
}

/**
 * Specification for a step that runs a script and routes control flow based
 * on its exit code. Shares all ScriptStepSpec fields except `output` (branch
 * steps produce no artifact or handoff) and requires a non-empty `onExit` map.
 */
export interface BranchStepSpec extends Omit<ScriptStepSpec, 'output' | 'kind'> {
  kind: 'branch';
  onExit: Record<string, 'abort' | 'continue' | string>;
}

/**
 * Specification for a step that fans out to multiple named sub-steps and
 * waits for all of them. Per spec, parallel steps do not support retry,
 * timeout, or context injection. `onFail` is limited to `'abort'` or a
 * step id — `'continue'` is not a valid option for a parallel step.
 */
export interface ParallelStepSpec extends StepBase {
  kind: 'parallel';
  branches: string[];
  onAllComplete?: string | undefined;
  onFail?: 'abort' | string | undefined;
}

/**
 * Specification for a terminal step that ends the flow with an optional
 * message and exit code. Terminal steps have no retry, timeout, or output.
 */
export interface TerminalStepSpec extends StepBase {
  kind: 'terminal';
  message?: string | undefined;
  exitCode?: number | undefined;
}

/**
 * Specification for a step that runs a set of body steps repeatedly until
 * a named condition is met or the maximum iteration count is reached.
 * `bodyGraph` is absent on the raw spec and injected by the compiler.
 */
export interface LoopStepSpec extends StepBase {
  kind: 'loop';
  body: Record<string, Step>;
  until: LoopUntilCondition;
  maxIterations: number;
  start?: string | undefined;
  dependsOn?: string[] | undefined;
  onFail?: 'abort' | string | undefined;
  maxRetries?: number | undefined;
  bodyGraph?: FlowGraph | undefined;
}

/**
 * Specification for an interactive step that pauses the run and prompts the
 * user for one or more answers. Questions may be supplied as a literal array
 * or sourced dynamically from a prior step's handoff via `{ from: 'stepId' }`.
 * The optional `output.schema` validates the collected answer map before it
 * is written as a handoff for downstream steps to consume.
 */
export interface AskStepSpec extends StepBase {
  kind: 'ask';
  name?: string | undefined;
  questions: Question[] | DynamicQuestionSource;
  output?: { schema: z.ZodType<unknown> } | undefined;
}

export type PromptStep = PromptStepSpec & { id: string };
export type ScriptStep = ScriptStepSpec & { id: string };
export type BranchStep = BranchStepSpec & { id: string };
export type ParallelStep = ParallelStepSpec & { id: string };
export type TerminalStep = TerminalStepSpec & { id: string };
export type LoopStep = LoopStepSpec & { id: string };
export type AskStep = AskStepSpec & { id: string };

export type Step =
  | PromptStep
  | ScriptStep
  | BranchStep
  | ParallelStep
  | TerminalStep
  | LoopStep
  | AskStep;

export interface FlowGraph {
  successors: ReadonlyMap<string, ReadonlySet<string>>;
  predecessors: ReadonlyMap<string, ReadonlySet<string>>;
  topoOrder: readonly string[];
  rootSteps: readonly string[];
  entry: string;
}

export interface FlowSpec<TInput> {
  name: string;
  version: string;
  description?: string;
  input: z.ZodType<TInput>;
  steps: Record<string, Step>;
  start?: string;
}

export interface Flow<TInput> extends FlowSpec<TInput> {
  graph: FlowGraph;
  stepOrder: string[];
  rootSteps: string[];
}

export type FlowStatus = 'running' | 'succeeded' | 'failed' | 'aborted' | 'paused';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'paused';

export interface StepState {
  status: StepStatus;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  attempts: number;
  artifacts?: string[] | undefined;
  handoffs?: string[] | undefined;
  errorMessage?: string | undefined;
}

/**
 * Snapshot of an in-flight ask step recorded on the run while it waits for
 * user input. Persisted alongside RunState so a resume in another process
 * can reconstruct the prompt that was issued and avoid asking again.
 */
export interface AwaitingInput {
  stepId: string;
  questions: Question[];
  promptedAt: string;
}

export interface RunState {
  runId: string;
  flowName: string;
  flowVersion: string;
  startedAt: string;
  updatedAt: string;
  input: unknown;
  steps: Record<string, StepState>;
  status: FlowStatus;
  awaitingInput?: AwaitingInput | undefined;
}
