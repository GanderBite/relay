import type { z } from '../zod.js';

export type StepKind = 'prompt' | 'script' | 'branch' | 'parallel' | 'terminal';

export interface StepBase {
  dependsOn?: string[];
  onFail?: 'abort' | 'continue' | string;
  maxRetries?: number;
  timeoutMs?: number;
  contextFrom?: string[];
}

export type PromptStepOutput =
  | { handoff: string; schema?: z.ZodType }
  | { artifact: string }
  | { handoff: string; artifact: string; schema?: z.ZodType };

export interface PromptStepSpec extends StepBase {
  promptFile: string;
  output: PromptStepOutput;
  provider?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  maxBudgetUsd?: number;
  providerOptions?: Record<string, unknown>;
}

export interface ScriptStepSpec extends StepBase {
  run: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  output?: { artifact?: string };
  onExit?: Record<string, 'abort' | 'continue' | string>;
}

export type BranchStepSpec = Omit<ScriptStepSpec, 'output'> & {
  onExit: Record<string, 'abort' | 'continue' | string>;
};

export interface ParallelStepSpec extends StepBase {
  branches: string[];
  onAllComplete?: string;
}

export interface TerminalStepSpec extends StepBase {
  message?: string;
  exitCode?: number;
}

export type PromptStep = PromptStepSpec & { kind: 'prompt'; id: string };
export type ScriptStep = ScriptStepSpec & { kind: 'script'; id: string };
export type BranchStep = BranchStepSpec & { kind: 'branch'; id: string };
export type ParallelStep = ParallelStepSpec & { kind: 'parallel'; id: string };
export type TerminalStep = TerminalStepSpec & { kind: 'terminal'; id: string };

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
