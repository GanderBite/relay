import type { CostTracker } from '../cost.js';
import { type AbortReason, type AwaitingInputSignal, StateWriteError } from '../errors.js';
import type { Flow } from '../flow/types.js';
import type { HandoffStore } from '../handoffs.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { StateMachine } from '../state.js';

import {
  errorMessageOf,
  isAbortLike,
  isAwaitingInputSignal,
  isPlainRecord,
} from './run-internal.js';
import { createStepDispatcher, stepOnFail } from './step-dispatch.js';
import type { StepResult } from './types.js';

/**
 * Run-scoped collaborators threaded into the DAG walker. Built once by the
 * Orchestrator's run/resume path and handed in verbatim — the walker never
 * mutates any of these fields, only the state machine they reference.
 */
export interface DagWalkContext {
  flow: Flow<unknown>;
  runDir: string;
  runId: string;
  flowDir: string;
  parallelism: number;
  abortController: AbortController;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  logger: Logger;
  providerByStep: Map<string, Provider>;
  providers: ProviderRegistry;
  provider: Provider;
  validatedInput: unknown;
  initialQueue: string[];
  /**
   * Working directory handed to every provider invocation for this run —
   * typically the per-run worktree path (or its flowDir-equivalent subpath)
   * when isolation is active. Undefined when worktree isolation is disabled
   * or auto-skipped, so the subprocess inherits the parent cwd.
   */
  invocationCwd: string | undefined;
  /**
   * Lifecycle callback forwarded from RunOptions. Fired once per successful
   * step completion inside the walker's drain loop. Errors thrown by the
   * callback are caught at the call site and never escape into the walker.
   */
  onStepComplete?: ((stepId: string, result: StepResult) => void) | undefined;
  /**
   * Verbose flag forwarded from RunOptions. Threaded into PromptStepExecContext
   * so the per-step event log writer can capture the raw provider envelope
   * alongside each translated InvocationEvent when set.
   */
  verbose?: boolean | undefined;
  /**
   * Record a typed abort cause against the enclosing run. Setter-only — the
   * walker never reads back the recorded value. The implementation in
   * run()/resume() ignores subsequent calls when a cause is already set, so
   * the first observer wins regardless of which abort site fires first.
   */
  recordAbortSource: (reason: AbortReason) => void;
}

/**
 * Discriminated outcome produced by `walkDag`. The orchestrator translates
 * this into a RunResult — `firstError` survives an `onFail=continue` policy
 * so embedding hosts see the originating cause, and `pausedStepId` is set
 * exactly when an ask step requested human input mid-walk.
 */
export interface WalkResult {
  status: 'succeeded' | 'failed' | 'aborted' | 'paused';
  firstError: Error | undefined;
  pausedStepId?: string | undefined;
}

/**
 * Drive the DAG walk loop until every reachable step has settled or the run
 * has been paused/aborted/failed. The walker delegates per-step state
 * transitions, retries, and abort handling to the StepDispatcher; its own job
 * is queue management, parallelism gating, and translating completions into
 * the discriminated WalkResult.
 *
 * Pure-ish: relies entirely on the supplied `DagWalkContext` for IO and state.
 * The walker installs and removes its own listener on the run's
 * AbortController; the caller still owns the controller and the SIGINT/SIGTERM
 * wiring around it.
 */
export async function walkDag(ctx: DagWalkContext): Promise<WalkResult> {
  const {
    flow,
    parallelism,
    abortController,
    stateMachine,
    logger,
    validatedInput,
    initialQueue,
    onStepComplete,
    recordAbortSource,
  } = ctx;

  const inputVars = isPlainRecord(validatedInput) ? validatedInput : {};

  const queue: string[] = [...initialQueue];
  const queued = new Set<string>(initialQueue);
  const completions: Array<{
    stepId: string;
    error?: unknown;
    result?: StepResult;
  }> = [];
  let notify: (() => void) | null = null;
  let runFailed = false;
  // First non-abort step error captured by the walker. Embedding hosts (the
  // CLI) read this off RunResult to map the underlying failure class to the
  // right exit code instead of conflating every step failure with code 1.
  // We only record the first one so the originating cause survives even when
  // onFail=continue keeps the walker draining other completions.
  let firstError: Error | undefined;
  // Captured when an ask step throws AwaitingInputSignal inside dispatchStep.
  // The dispatcher trips the abort controller; this flag flips the walker
  // into the paused outcome path. Once paused, subsequent step failures
  // (typically the abort cascade rejecting in flight branches) are ignored —
  // the originating pause is the outcome the operator needs to act on.
  let pausedSignal: AwaitingInputSignal | undefined;

  const dispatcher = createStepDispatcher({
    flow: ctx.flow,
    runDir: ctx.runDir,
    runId: ctx.runId,
    flowDir: ctx.flowDir,
    abortController: ctx.abortController,
    handoffStore: ctx.handoffStore,
    costTracker: ctx.costTracker,
    stateMachine: ctx.stateMachine,
    logger: ctx.logger,
    providers: ctx.providers,
    provider: ctx.provider,
    providerByStep: ctx.providerByStep,
    inputVars,
    invocationCwd: ctx.invocationCwd,
    verbose: ctx.verbose,
    signalPause: (signal) => {
      pausedSignal = signal;
    },
    signalSiblingFailureAbort: (reason) => {
      recordAbortSource(reason);
    },
  });

  const waitForCompletion = (): Promise<void> =>
    new Promise((resolve) => {
      notify = resolve;
    });

  const onAbort = (): void => {
    const cb = notify;
    notify = null;
    if (cb !== null) cb();
  };
  if (!abortController.signal.aborted) {
    abortController.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Everything past the registration runs inside a try/finally so the abort
  // listener is removed even when the walker throws before reaching a normal
  // return (e.g. a state.json save failure). Without this guard, listeners
  // leak onto the shared AbortController and node eventually warns with
  // MaxListenersExceededWarning on long or frequently-failing runs.
  try {
    const enqueueWalker = (stepId: string): void => {
      void dispatcher
        .dispatchStep(stepId)
        .then(
          (result) => {
            completions.push({ stepId, result });
          },
          (error: unknown) => {
            completions.push({ stepId, error });
          },
        )
        .finally(() => {
          const cb = notify;
          notify = null;
          if (cb !== null) cb();
        });
    };

    const enqueueReady = (): void => {
      const state = stateMachine.getState().steps;
      for (const candidate of flow.graph.topoOrder) {
        const candState = state[candidate];
        if (candState === undefined || candState.status !== 'pending') continue;
        if (queued.has(candidate)) continue;
        const preds = flow.graph.predecessors.get(candidate);
        if (preds === undefined) continue;
        let ready = true;
        for (const p of preds) {
          const predState = state[p];
          const predStatus = predState?.status;
          // `continue` onFail lets dependents run even after a failure.
          const pred = flow.steps[p];
          const predAllowsContinue =
            pred !== undefined &&
            pred.kind !== 'terminal' &&
            pred.kind !== 'parallel' &&
            pred.kind !== 'ask' &&
            pred.onFail === 'continue';
          const ok =
            predStatus === 'succeeded' ||
            predStatus === 'skipped' ||
            (predStatus === 'failed' && predAllowsContinue);
          if (!ok) {
            ready = false;
            break;
          }
        }
        if (ready) {
          queue.push(candidate);
          queued.add(candidate);
        }
      }
    };

    while (queue.length > 0 || dispatcher.inflightSize() > 0) {
      if (abortController.signal.aborted) break;

      while (
        !runFailed &&
        pausedSignal === undefined &&
        queue.length > 0 &&
        dispatcher.inflightSize() < parallelism
      ) {
        const next = queue.shift();
        if (next === undefined) break;
        queued.delete(next);
        enqueueWalker(next);
      }

      if (dispatcher.inflightSize() === 0 && completions.length === 0) break;

      if (completions.length === 0) {
        await waitForCompletion();
      }

      while (completions.length > 0) {
        const completed = completions.shift();
        if (completed === undefined) break;
        // dispatchStep's finally already released the inflight slot before
        // pushing this completion; nothing left to clean up here.

        if (completed.error !== undefined && !isAbortLike(completed.error)) {
          // A state.json write failure inside dispatchStep is not a step
          // failure — it is an I/O failure the caller needs to observe and
          // react to (retry the run, widen disk quota, etc.). Propagate it
          // verbatim so the CLI's exit-code map surfaces the STATE_WRITE
          // code instead of swallowing the error as an onFail=abort step.
          if (completed.error instanceof StateWriteError) {
            throw completed.error;
          }
          // The ask step intercept inside dispatchStep already pauses the
          // run, persists state, and trips the abort controller. The signal
          // surfaces here on the original ask step's own completion record;
          // skip every failure handling path so the paused outcome is not
          // shadowed by spurious onFail / firstError bookkeeping.
          if (isAwaitingInputSignal(completed.error)) {
            continue;
          }
          // Once the run has been paused by an ask step, ignore subsequent
          // failures — they are typically the abort cascade rejecting the
          // sibling parallel branches that were still in flight when the
          // pause fired. The pause is the outcome the operator needs to
          // act on; surfacing the cascade as the firstError would mask it.
          if (pausedSignal !== undefined) {
            continue;
          }
          // Capture the first non-abort, non-state-write error so RunResult
          // can carry it back to embedding hosts. Subsequent failures (e.g.
          // a downstream timeout that fired after the originating exhaustion)
          // do not overwrite — the originating cause is the useful one.
          if (firstError === undefined && completed.error instanceof Error) {
            firstError = completed.error;
          }
          const message = errorMessageOf(completed.error);
          const step = flow.steps[completed.stepId];
          const policy = step !== undefined ? stepOnFail(step) : 'abort';
          if (policy === 'continue') {
            logger.warn(
              {
                event: 'step.continue_after_fail',
                stepId: completed.stepId,
                error: message,
              },
              'step failed; onFail=continue keeps downstream steps going',
            );
          } else {
            runFailed = true;
          }
        } else if (completed.error === undefined && completed.result !== undefined) {
          // Lifecycle hook for embedding hosts. Fired only on successful
          // completion. The callback is wrapped in try/catch so a buggy
          // subscriber cannot abort the run or corrupt state — the worst
          // case is a warn-level log entry.
          if (onStepComplete !== undefined) {
            try {
              onStepComplete(completed.stepId, completed.result);
            } catch (cbErr) {
              logger.warn(
                {
                  event: 'onStepComplete.callback_error',
                  stepId: completed.stepId,
                  error: cbErr,
                },
                'onStepComplete callback threw',
              );
            }
          }
        }

        const saveResult = await stateMachine.save();
        if (saveResult.isErr()) {
          logger.error(
            { event: 'state.save_failed', error: saveResult.error.message },
            'state.json atomic write failed',
          );
          throw saveResult.error;
        }
      }

      if (!runFailed && !abortController.signal.aborted) enqueueReady();
    }

    if (pausedSignal !== undefined) {
      return { status: 'paused', firstError: undefined, pausedStepId: pausedSignal.stepId };
    }
    if (abortController.signal.aborted) return { status: 'aborted', firstError };
    return {
      status: runFailed ? 'failed' : 'succeeded',
      firstError: runFailed ? firstError : undefined,
    };
  } finally {
    abortController.signal.removeEventListener('abort', onAbort);
  }
}
