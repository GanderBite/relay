import type { ZodSchema } from '../zod.js';

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

export type StepKind = 'prompt' | 'script' | 'branch' | 'parallel' | 'terminal';

// ---------------------------------------------------------------------------
// StepBase — fields present on every step spec
// ---------------------------------------------------------------------------

export interface StepBase {
  kind: StepKind;
  dependsOn?: string[];
  onFail?: 'abort' | 'continue' | string;
  maxRetries?: number;
  timeoutMs?: number;
  contextFrom?: string[];
}

// ---------------------------------------------------------------------------
// PromptStepOutput — discriminated union on presence of handoff / artifact
// ---------------------------------------------------------------------------

export type PromptStepOutput =
  | { handoff: string; schema?: ZodSchema }
  | { artifact: string }
  | { handoff: string; artifact: string; schema?: ZodSchema };

// ---------------------------------------------------------------------------
// Step spec types
// ---------------------------------------------------------------------------

export interface PromptStepSpec extends StepBase {
  kind: 'prompt';
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
  kind: 'script';
  run: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  output?: {
    handoff?: string;
    schema?: ZodSchema;
    artifact?: string;
  };
  onExit?: Record<string, 'abort' | 'continue' | string>;
}

export type BranchStepSpec = Omit<ScriptStepSpec, 'output'> & {
  kind: 'branch';
  onExit: Record<string, 'abort' | 'continue' | string>;
};

export interface ParallelStepSpec extends StepBase {
  kind: 'parallel';
  branches: string[];
  onAllComplete?: string;
}

export interface TerminalStepSpec extends StepBase {
  kind: 'terminal';
  message?: string;
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Step — discriminated union on kind, with compiler-injected id
// ---------------------------------------------------------------------------

export type Step =
  | (PromptStepSpec & { id: string })
  | (ScriptStepSpec & { id: string })
  | (BranchStepSpec & { id: string })
  | (ParallelStepSpec & { id: string })
  | (TerminalStepSpec & { id: string });

// ---------------------------------------------------------------------------
// FlowGraph — structural contract; implemented by buildGraph in flow/graph.ts
// ---------------------------------------------------------------------------

export interface FlowGraph {
  /** Adjacency list: stepId -> set of stepIds that depend on it (successors). */
  successors: ReadonlyMap<string, ReadonlySet<string>>;
  /** Adjacency list: stepId -> set of stepIds it depends on (predecessors). */
  predecessors: ReadonlyMap<string, ReadonlySet<string>>;
}

// ---------------------------------------------------------------------------
// FlowSpec — user-authored flow definition
// ---------------------------------------------------------------------------

export interface FlowSpec<TInput> {
  name: string;
  version: string;
  description?: string;
  defaultProvider?: string;
  input: ZodSchema<TInput>;
  steps: Record<string, Step>;
  start?: string;
}

// ---------------------------------------------------------------------------
// Flow — compiled form; FlowSpec plus DAG data produced by the flow compiler
// ---------------------------------------------------------------------------

export interface Flow<TInput> extends FlowSpec<TInput> {
  graph: FlowGraph;
  stepOrder: string[];
  rootSteps: string[];
}

// ---------------------------------------------------------------------------
// RunState / StepState — JSON-serialisable run checkpoint (state.json)
// ---------------------------------------------------------------------------

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
