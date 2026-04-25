import type { z } from '../zod.js';

export type StepKind = 'prompt' | 'script' | 'branch' | 'parallel' | 'terminal';

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
  env?: Record<string, string> | undefined;
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

export type PromptStep = PromptStepSpec & { id: string };
export type ScriptStep = ScriptStepSpec & { id: string };
export type BranchStep = BranchStepSpec & { id: string };
export type ParallelStep = ParallelStepSpec & { id: string };
export type TerminalStep = TerminalStepSpec & { id: string };

export type Step = PromptStep | ScriptStep | BranchStep | ParallelStep | TerminalStep;

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

export type FlowStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StepState {
  status: StepStatus;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  attempts: number;
  artifacts?: string[] | undefined;
  handoffs?: string[] | undefined;
  errorMessage?: string | undefined;
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
}
