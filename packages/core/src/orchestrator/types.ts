import type { BranchStepResult } from './exec/branch.js';
import type { ParallelStepResult } from './exec/parallel.js';
import type { PromptStepResult } from './exec/prompt.js';
import type { ScriptStepResult } from './exec/script.js';
import type { TerminalStepResult } from './exec/terminal.js';

/**
 * Unified return shape for every step executor. Discriminated by the `kind`
 * field on the variants that carry one; script and branch keep their
 * exit-code shape without a kind since they predate this union.
 *
 * The Orchestrator treats every variant the same way for state transitions;
 * the variant shape only matters to callers reading the finished RunResult.
 */
export type StepResult =
  | PromptStepResult
  | ScriptStepResult
  | BranchStepResult
  | ParallelStepResult
  | TerminalStepResult;
