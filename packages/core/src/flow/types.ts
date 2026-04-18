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
  dependsOn?: string[];
}

export type PromptStepOutput =
  | { handoff: string; schema?: z.ZodType }
  | { artifact: string }
  | { handoff: string; artifact: string; schema?: z.ZodType };

/**
 * Specification for a step that invokes a Claude prompt via a provider.
 * Supports retry, timeout, budget cap, context injection, and structured
 * output routing (handoff and/or artifact).
 */
export interface PromptStepSpec extends StepBase {
  kind: 'prompt';
  promptFile: string;
  provider?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  contextFrom?: string[];
  output: PromptStepOutput;
  maxRetries?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  onFail?: 'abort' | 'continue' | string;
  providerOptions?: Record<string, unknown>;
}

/**
 * Specification for a step that runs a shell command or script.
 * Supports retry, timeout, exit-code routing, and optional artifact output.
 */
export interface ScriptStepSpec extends StepBase {
  kind: 'script';
  run: string | string[];
  env?: Record<string, string>;
  cwd?: string;
  output?: { artifact?: string };
  onExit?: Record<string, 'abort' | 'continue' | string>;
  maxRetries?: number;
  timeoutMs?: number;
  onFail?: 'abort' | 'continue' | string;
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
  onAllComplete?: string;
  onFail?: 'abort' | string;
}

/**
 * Specification for a terminal step that ends the flow with an optional
 * message and exit code. Terminal steps have no retry, timeout, or output.
 */
export interface TerminalStepSpec extends StepBase {
  kind: 'terminal';
  message?: string;
  exitCode?: number;
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
  defaultProvider?: string;
  input: z.ZodType<TInput>;
  steps: Record<string, Step>;
  start?: string;
}

export interface Flow<TInput> extends FlowSpec<TInput> {
  graph: FlowGraph;
  stepOrder: string[];
  rootSteps: string[];
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StepState {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  artifacts?: string[];
  handoffs?: string[];
  errorMessage?: string;
}

export interface RunState {
  runId: string;
  flowName: string;
  flowVersion: string;
  startedAt: string;
  updatedAt: string;
  input: unknown;
  steps: Record<string, StepState>;
  status: RunStatus;
}
