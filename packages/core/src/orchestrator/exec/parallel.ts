import { PipelineError, StepFailureError } from '../../errors.js';
import type { ParallelStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';

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
  | 'paused'
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
  runId: string;
  step: ParallelStepSpec;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  dispatch: (branchStepId: string) => Promise<unknown>;
  getBranchStatus?: (branchStepId: string) => BranchStatusSnapshot;
  getBranchResult?: (branchStepId: string) => unknown;
  /**
   * Optional notifier called once with the id of the first branch whose
   * dispatch rejected when the parallel executor is about to throw the
   * aggregate StepFailureError. Lets the orchestrator record a typed abort
   * cause for the run before the failure propagates out — without it the
   * parallel-branch failure path produces no observable AbortReason. The
   * callback is best-effort and must not throw; thrown values are caught and
   * ignored so a buggy notifier cannot mask the real failure.
   */
  onBranchFailure?: (branchStepId: string) => void;
}

export interface ParallelStepResult {
  kind: 'parallel';
  branches: Record<string, unknown>;
}

interface BranchOutcome {
  branchId: string;
  status: 'fulfilled' | 'rejected' | 'skipped';
  value?: unknown;
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
    // Notify the orchestrator with the id of the first failed branch so a
    // typed AbortReason can be recorded for the run before the aggregate
    // failure throws. Best-effort: a bad notifier must not mask the real
    // failure that's about to surface as a StepFailureError.
    const firstFailure = failures[0];
    if (ctx.onBranchFailure !== undefined && firstFailure !== undefined) {
      try {
        ctx.onBranchFailure(firstFailure.branchId);
      } catch {
        // intentionally swallowed
      }
    }

    const branchFailures = failures.map(
      ({
        branchId,
        reason,
      }): { branch: string; cause: PipelineError | { code: string; message: string } } => {
        if (reason instanceof PipelineError) {
          return { branch: branchId, cause: reason };
        }
        const message = reason instanceof Error ? reason.message : String(reason);
        const code =
          reason !== null &&
          typeof reason === 'object' &&
          'code' in reason &&
          typeof (reason as { code: unknown }).code === 'string'
            ? (reason as { code: string }).code
            : 'UNKNOWN';
        return { branch: branchId, cause: { code, message } };
      },
    );

    throw new StepFailureError(
      `parallel step "${step.id}" failed: ${failures.length} of ${step.branches.length} branch(es) failed`,
      ctx.stepId,
      ctx.attempt,
      {
        branchFailures,
        runId: ctx.runId,
      },
    );
  }

  const branchResults: Record<string, unknown> = {};
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') continue;
    branchResults[outcome.branchId] = outcome.value;
  }

  return { kind: 'parallel', branches: branchResults };
}
