import type { BranchRunnerResult } from './exec/branch.js';
import type { ParallelRunnerResult } from './exec/parallel.js';
import type { PromptRunnerResult } from './exec/prompt.js';
import type { ScriptRunnerResult } from './exec/script.js';
import type { TerminalRunnerResult } from './exec/terminal.js';

/**
 * Unified return shape for every step executor. Discriminated by the `kind`
 * field on the variants that carry one; script and branch keep their
 * exit-code shape without a kind since they predate this union.
 *
 * The Runner treats every variant the same way for state transitions; the
 * variant shape only matters to callers reading the finished RunResult.
 */
export type RunnerResult =
  | PromptRunnerResult
  | ScriptRunnerResult
  | BranchRunnerResult
  | ParallelRunnerResult
  | TerminalRunnerResult;
