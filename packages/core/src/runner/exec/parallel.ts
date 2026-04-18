import { StepFailureError } from '../../errors.js';
import type { ParallelStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';

/**
 * The value returned by a branch dispatch call. Callers own the shape;
 * the parallel executor treats it as opaque.
 */
export type StepResult = unknown;

/**
 * Minimum context required by the parallel executor. The `dispatch` callback
 * is the only coupling to the Runner — it handles state updates, retries, and
 * the actual step logic for each branch.
 */
export interface ParallelExecutorContext {
  stepId: string;
  step: ParallelStepSpec;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  dispatch: (branchStepId: string) => Promise<StepResult>;
}

export interface ParallelStepResult {
  kind: 'parallel';
  branches: Record<string, StepResult>;
}

interface BranchOutcome {
  branchId: string;
  status: 'fulfilled' | 'rejected';
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
 */
export async function executeParallel(
  step: ParallelStepSpec,
  ctx: ParallelExecutorContext,
): Promise<ParallelStepResult> {
  const branchPromises: Promise<BranchOutcome>[] = step.branches.map((branchId) =>
    ctx
      .dispatch(branchId)
      .then(
        (value): BranchOutcome => ({ branchId, status: 'fulfilled', value }),
        (reason: unknown): BranchOutcome => ({ branchId, status: 'rejected', reason }),
      ),
  );

  const outcomes = await Promise.all(branchPromises);

  const failures = outcomes.filter((o): o is BranchOutcome & { status: 'rejected' } => o.status === 'rejected');
  const successes = outcomes.filter((o): o is BranchOutcome & { status: 'fulfilled' } => o.status === 'fulfilled');

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
  for (const { branchId, value } of successes) {
    branchResults[branchId] = value;
  }

  return { kind: 'parallel', branches: branchResults };
}
