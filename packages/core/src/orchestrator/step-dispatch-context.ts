import type { CostTracker } from '../cost.js';
import type { Flow, Step, StepStatus } from '../flow/types.js';
import type { HandoffStore } from '../handoffs.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { StateMachine } from '../state.js';
import type { BranchStatusSnapshot } from './exec/parallel.js';
import type { StepResult } from './types.js';

/**
 * Unified context bag built once per step dispatch and passed to every
 * registered step-kind executor. Each executor reads only the subset of
 * fields it needs and adapts them to its own per-kind signature.
 *
 * Holds the long-lived run-scoped state (state machine, handoff store, cost
 * tracker, logger, providers) plus the per-step coordinates (stepId, attempt)
 * plus the closures that compose an executor with the rest of the
 * orchestrator (the parallel branch dispatch, the loop body-step dispatch,
 * branch status lookups). Keeping these as fields rather than positional
 * arguments lets new step kinds opt into existing capabilities by simply
 * declaring an interface and reading from this bag.
 *
 * The shape is a superset of `StepExecutionContext` — defined as its own
 * interface (rather than extending) so this module avoids a circular import
 * with `orchestrator.ts`, which depends on the registry transitively.
 */
export interface StepDispatchContext {
  flow: Flow<unknown>;
  runDir: string;
  runId: string;
  flowName: string;
  flowDir: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  logger: Logger;
  providers: ProviderRegistry;
  /**
   * Default provider resolved at run start. Per-step overrides flow through
   * `providerByStep`; this field is the fallback for executors that have no
   * per-step entry (terminal, ask, loop dispatch surface).
   */
  provider: Provider;
  /**
   * Working directory the provider subprocess should run in — the per-run
   * git worktree when isolation is active, otherwise undefined so the
   * subprocess inherits the parent process cwd.
   */
  cwd?: string | undefined;
  /**
   * Resolved provider per prompt step id. Built once at run start by
   * `checkCapabilities`; consulted by the prompt executor so per-step
   * provider overrides take effect.
   */
  providerByStep: ReadonlyMap<string, Provider>;
  /**
   * Plain-object projection of the validated flow input. Spread into script,
   * branch, and prompt template contexts so authors can reference
   * `{{input.<key>}}` from their argv or prompt template.
   */
  inputVars: Record<string, unknown>;
  /**
   * When true, the prompt executor's per-step event log writer captures the
   * raw stream-json envelope alongside the translated InvocationEvent.
   * Threaded through from RunOptions.verbose.
   */
  verbose?: boolean | undefined;
  /**
   * Dispatch a sibling branch step inside a parallel step. Owned by the
   * orchestrator's walker so each branch reuses the full step pipeline
   * (state transitions, retries, executor selection). Surfaced here as a
   * closure so the parallel executor stays decoupled from the walker
   * implementation.
   */
  dispatchStep: (stepId: string) => Promise<StepResult>;
  /**
   * Dispatch a single body step inside a loop iteration. Mirrors
   * `dispatchStep` but threads the iteration index and parent-loop id so
   * body-step state entries are seeded under the synthesised key the loop
   * executor uses for resume short-circuiting.
   */
  dispatchBodyStep: (
    bodyStepId: string,
    bodyStep: Step,
    loopIter: number,
    loopStepId: string,
  ) => Promise<StepResult>;
  /**
   * Snapshot the persisted status of a branch step so the parallel executor
   * can short-circuit branches that already succeeded on a prior attempt.
   */
  getBranchStatus: (branchStepId: string) => BranchStatusSnapshot | StepStatus | 'unknown';
  /**
   * Cached step result for an already-succeeded branch step, if any. Used
   * alongside `getBranchStatus` to avoid re-dispatching the branch on a
   * retry of the parent parallel step.
   */
  getBranchResult: (branchStepId: string) => unknown;
  /**
   * Iteration to resume from when the prior run paused mid-loop, or
   * undefined to start fresh from iteration 1. Read by the loop executor.
   */
  getResumedLoopIter: (loopStepId: string) => number | undefined;
  /**
   * Iteration-boundary hook for the loop executor. Sweeps stale body-step
   * state entries back to pending and saves the state machine.
   */
  onLoopIterationStart: (loopStepId: string, iter: number) => Promise<void>;
  /**
   * Predicate the loop executor uses to skip body steps that already
   * succeeded in this iteration on a prior run.
   */
  isLoopBodyStepSucceeded: (loopStepId: string, bodyStepId: string, iter: number) => boolean;
}
