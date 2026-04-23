import { StepFailureError } from '../../errors.js';
import type { ParallelStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';

/**
 * The value returned by a branch dispatch call. Callers own the shape;
 * the parallel executor treats it as opaque.
 */
export type StepResult = unknown;

/**
 * Status snapshot for a branch as seen by the parallel executor. The executor
 * consults this before dispatching to avoid re-running a branch that already
 * succeeded on a prior attempt of the parent parallel step.
 */
export type BranchStatusSnapshot =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'unknown';

/**
 * Minimum context required by the parallel executor. The `dispatch` callback
 * is the only coupling to the Orchestrator — it handles state updates, retries, and
 * the actual step logic for each branch. `getBranchStatus` and
 * `getBranchResult` let the executor short-circuit branches that already
 * succeeded on a previous attempt of the parent step (see resume / retry).
 */
export interface ParallelExecutorContext {
  stepId: string;
  step: ParallelStepSpec;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  dispatch: (branchStepId: string) => Promise<StepResult>;
  getBranchStatus?: (branchStepId: string) => BranchStatusSnapshot;
  getBranchResult?: (branchStepId: string) => StepResult | undefined;
}

export interface ParallelStepResult {
  kind: 'parallel';
  branches: Record<string, StepResult>;
}

interface BranchOutcome {
  branchId: string;
  status: 'fulfilled' | 'rejected' | 'skipped';
  value?: StepResult;
  reason?: unknown;
}

/**
 * Fans out to all branches concurrently via `dispatch`, then fans in.
 *
 * On all-success: returns { kind: 'parallel', branches: Record<branchId, result> }.
 * On any failure: throws StepFailureError with aggregated branch failure details.
 *
 * Abort propagation is passive — individual dispatch calls observe the abort
 * signal through their own execution context and reject accordingly. Those
 * rejections are captured in the aggregate failure path.
 *
 * Branches whose persisted status is already `succeeded` (e.g. when the parent
 * parallel step is being retried after a mixed-outcome first attempt) are
 * skipped without a dispatch call so the StateMachine does not reject the
 * transition. When a cached result is available it is carried into the
 * aggregate branch map; otherwise the branch is represented by `undefined`.
 */
export async function executeParallel(
  step: ParallelStepSpec,
  ctx: ParallelExecutorContext,
): Promise<ParallelStepResult> {
  const branchPromises: Promise<BranchOutcome>[] = step.branches.map((branchId) => {
    const status = ctx.getBranchStatus?.(branchId) ?? 'unknown';
    if (status === 'succeeded') {
      const cached = ctx.getBranchResult?.(branchId);
      return Promise.resolve<BranchOutcome>({
        branchId,
        status: 'skipped',
        value: cached,
      });
    }
    return ctx.dispatch(branchId).then(
      (value): BranchOutcome => ({ branchId, status: 'fulfilled', value }),
      (reason: unknown): BranchOutcome => ({ branchId, status: 'rejected', reason }),
    );
  });

  const outcomes = await Promise.all(branchPromises);

  const failures = outcomes.filter(
    (o): o is BranchOutcome & { status: 'rejected' } => o.status === 'rejected',
  );

  if (failures.length > 0) {
    const branchFailures = failures.map(({ branchId, reason }) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      return { branch: branchId, message, cause: reason };
    });

    throw new StepFailureError(
      `parallel step "${step.id}" failed: ${failures.length} of ${step.branches.length} branch(es) failed`,
      ctx.stepId,
      ctx.attempt,
      {
        branchFailures: branchFailures.map(({ branch, message }) => ({
          branch,
          message,
        })),
      },
    );
  }

  const branchResults: Record<string, StepResult> = {};
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') continue;
    branchResults[outcome.branchId] = outcome.value;
  }

  return { kind: 'parallel', branches: branchResults };
}
