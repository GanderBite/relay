import type { z } from '../zod.js';

export type RunnerKind = 'prompt' | 'script' | 'branch' | 'parallel' | 'terminal';

/**
 * The minimum fields shared by every step type.
 * Each per-kind spec explicitly opts in to the additional fields (retry,
 * timeout, contextFrom, onFail, etc.) that apply to it — nothing is silently
 * inherited here.
 */
export interface RunnerBase {
  /** The step's stable identifier. Set by the race compiler, not the builder. */
  id: string;
  /** Ids of steps that must succeed before this one runs. */
  dependsOn?: string[];
}

export type PromptRunnerOutput =
  | { baton: string; schema?: z.ZodType }
  | { artifact: string }
  | { baton: string; artifact: string; schema?: z.ZodType };

/**
 * Specification for a runner that invokes a Claude prompt via a provider.
 * Supports retry, timeout, budget cap, context injection, and structured
 * output routing (baton and/or artifact).
 */
export interface PromptRunnerSpec extends RunnerBase {
  kind: 'prompt';
  promptFile: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  contextFrom?: string[];
  output: PromptRunnerOutput;
  maxRetries?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  onFail?: 'abort' | 'continue' | string;
}

/**
 * Specification for a runner that runs a shell command or script.
 * Supports retry, timeout, exit-code routing, and optional artifact output.
 */
export interface ScriptRunnerSpec extends RunnerBase {
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
 * Specification for a runner that runs a script and routes control flow based
 * on its exit code. Shares all ScriptRunnerSpec fields except `output` (branch
 * runners produce no artifact or baton) and requires a non-empty `onExit` map.
 */
export interface BranchRunnerSpec extends Omit<ScriptRunnerSpec, 'output' | 'kind'> {
  kind: 'branch';
  onExit: Record<string, 'abort' | 'continue' | string>;
}

/**
 * Specification for a step that fans out to multiple named sub-steps and
 * waits for all of them. Per spec, parallel steps do not support retry,
 * timeout, or context injection. `onFail` is limited to `'abort'` or a
 * runner id — `'continue'` is not a valid option for a parallel runner.
 */
export interface ParallelRunnerSpec extends RunnerBase {
  kind: 'parallel';
  branches: string[];
  onAllComplete?: string;
  onFail?: 'abort' | string;
}

/**
 * Specification for a terminal runner that ends the race with an optional
 * message and exit code. Terminal steps have no retry, timeout, or output.
 */
export interface TerminalRunnerSpec extends RunnerBase {
  kind: 'terminal';
  message?: string;
  exitCode?: number;
}

export type PromptRunner = PromptRunnerSpec & { id: string };
export type ScriptRunner = ScriptRunnerSpec & { id: string };
export type BranchRunner = BranchRunnerSpec & { id: string };
export type ParallelRunner = ParallelRunnerSpec & { id: string };
export type TerminalRunner = TerminalRunnerSpec & { id: string };

export type Runner = PromptRunner | ScriptRunner | BranchRunner | ParallelRunner | TerminalRunner;

export interface RaceGraph {
  successors: ReadonlyMap<string, ReadonlySet<string>>;
  predecessors: ReadonlyMap<string, ReadonlySet<string>>;
  topoOrder: readonly string[];
  rootRunners: readonly string[];
  entry: string;
}

export interface RaceSpec<TInput> {
  name: string;
  version: string;
  description?: string;
  input: z.ZodType<TInput>;
  runners: Record<string, Runner>;
  start?: string;
}

export interface Race<TInput> extends RaceSpec<TInput> {
  graph: RaceGraph;
  runnerOrder: string[];
  rootRunners: string[];
}

export type RaceStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export type RunnerStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface RunnerState {
  status: RunnerStatus;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  artifacts?: string[];
  batons?: string[];
  errorMessage?: string;
}

export interface RaceState {
  runId: string;
  raceName: string;
  raceVersion: string;
  startedAt: string;
  updatedAt: string;
  input: unknown;
  runners: Record<string, RunnerState>;
  status: RaceStatus;
}
