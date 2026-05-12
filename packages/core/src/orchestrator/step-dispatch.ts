import type { CostTracker } from '../cost.js';
import { type AbortReason, type AwaitingInputSignal, FlowDefinitionError } from '../errors.js';
import type { Flow, Step } from '../flow/types.js';
import type { HandoffStore } from '../handoffs.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { StateMachine } from '../state.js';

import { type AskStepResult, askIterationAnswerHandoffPath, executeAsk } from './exec/ask.js';
import type { BranchStatusSnapshot } from './exec/parallel.js';
import { writeLiveState } from './live-state.js';
import { withRetry } from './retry.js';
import {
  errorMessageOf,
  isAbortLike,
  isAwaitingInputSignal,
  RunAbortedError,
} from './run-internal.js';
import type { StepDispatchContext } from './step-dispatch-context.js';
import { defaultStepRegistry } from './step-kind-registry.js';
import type { StepResult } from './types.js';

// Mirrors the default in flow/schemas.ts. Duplicated here so the walker can
// backstop hand-built PromptStepSpec values that bypassed the schema parse
// (e.g. spec literals authored without going through promptStep(...)).
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;

/**
 * Inputs the dispatcher needs to drive a single step end-to-end. The walker
 * owns the abort controller, the state machine, and the per-run collaborators;
 * the dispatcher is constructed once per walk and reads/mutates those
 * references through this bag.
 *
 * `signalPause` and `signalSiblingFailureAbort` are setter-only callbacks the
 * walker uses to surface pause/abort causes without coupling the dispatcher
 * to the walker's outcome state.
 */
export interface StepDispatcherDeps {
  flow: Flow<unknown>;
  runDir: string;
  runId: string;
  flowDir: string;
  abortController: AbortController;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  logger: Logger;
  providers: ProviderRegistry;
  provider: Provider;
  providerByStep: Map<string, Provider>;
  inputVars: Record<string, unknown>;
  invocationCwd: string | undefined;
  verbose: boolean | undefined;
  signalPause: (signal: AwaitingInputSignal) => void;
  signalSiblingFailureAbort: (reason: AbortReason) => void;
}

export interface StepDispatcher {
  dispatchStep: (stepId: string) => Promise<StepResult>;
  inflightSize: () => number;
}

/**
 * Construct the per-walk step dispatcher. The returned `dispatchStep`
 * runs one step end-to-end — state transitions, retry, abort flow, and
 * either completeStep (with the executor's result) or failStep on error.
 * Both the walker and the parallel executor's branch dispatch share this
 * single entry point, so each path performs the same state mutations exactly
 * once per step.
 */
export function createStepDispatcher(deps: StepDispatcherDeps): StepDispatcher {
  const {
    flow,
    runDir,
    runId,
    flowDir,
    abortController,
    handoffStore,
    costTracker,
    stateMachine,
    logger,
    providers,
    provider,
    providerByStep,
    inputVars,
    invocationCwd,
    verbose,
    signalPause,
    signalSiblingFailureAbort,
  } = deps;

  const inflight = new Set<string>();

  // Named handler + finally cleanup so each raceAbort call removes its own
  // listener on the happy path. Without removal, listeners accumulate on the
  // shared AbortController for the lifetime of the run — node prints a
  // MaxListenersExceededWarning at 11+ on any reasonably sized flow.
  const raceAbort = async <T>(work: Promise<T>): Promise<T> => {
    if (abortController.signal.aborted) {
      throw new RunAbortedError();
    }
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = (): void => {
        reject(new RunAbortedError());
      };
      abortController.signal.addEventListener('abort', abortHandler, { once: true });
    });
    try {
      return await Promise.race([work, abortPromise]);
    } finally {
      if (abortHandler !== undefined) {
        abortController.signal.removeEventListener('abort', abortHandler);
      }
    }
  };

  // Branch-status snapshot the parallel executor consults to skip
  // already-succeeded branches on retry. Defined once per walk so the
  // dispatch context can carry it into every step invocation without
  // re-allocating the closure.
  const getBranchStatus = (branchStepId: string): BranchStatusSnapshot => {
    const branchState = stateMachine.getState().steps[branchStepId];
    return (branchState?.status ?? 'unknown') as BranchStatusSnapshot;
  };

  // Resumed-iteration lookup the loop executor uses to pick up at the
  // iteration the prior run paused on. Returns undefined for any other
  // loop or any other awaitingInput shape.
  const getResumedLoopIter = (loopStepId: string): number | undefined => {
    const awaiting = stateMachine.getState().awaitingInput;
    if (awaiting?.loopStepId === loopStepId) return awaiting.loopIter;
    return undefined;
  };

  // Iteration-boundary sweep used by the loop executor: at the top of
  // every iteration past the resumed one, drop any settled body-step
  // state entries back to pending so startStep does not trip on a stale
  // succeeded/paused/failed status carried over from the prior iteration.
  // Iteration 1 (or the resumed iteration) skips the sweep so resume can
  // use isLoopBodyStepSucceeded to short-circuit body steps that already
  // completed.
  const onLoopIterationStart = async (loopStepId: string, iter: number): Promise<void> => {
    const stepLoggerLoop = logger.child({ stepId: loopStepId });
    const baseIter = getResumedLoopIter(loopStepId) ?? 1;
    if (iter > baseIter) {
      const sweepResult = stateMachine.sweepBodySteps(loopStepId);
      if (sweepResult.isErr()) {
        stepLoggerLoop.error(
          {
            event: 'state.transition_failed',
            stepId: loopStepId,
            iter,
            error: sweepResult.error.message,
          },
          'state transition failed while sweeping loop body steps',
        );
      }
      const sweepSave = await stateMachine.save();
      if (sweepSave.isErr()) {
        stepLoggerLoop.error(
          { event: 'state.save_failed', error: sweepSave.error.message },
          'state.json atomic write failed during loop iteration sweep',
        );
        throw sweepSave.error;
      }
    }
    stepLoggerLoop.debug(
      { event: 'loop.iteration.boundary', stepId: loopStepId, iter },
      'loop iteration boundary entered',
    );
  };

  const isLoopBodyStepSucceeded = (
    loopStepId: string,
    bodyStepId: string,
    iter: number,
  ): boolean => {
    const key = StateMachine.bodyStepStateKey(loopStepId, bodyStepId);
    const bodyState = stateMachine.getState().steps[key];
    return bodyState?.status === 'succeeded' && bodyState.iter === iter;
  };

  const runExecutor = async (step: Step, attempt: number): Promise<StepResult> => {
    const stepLogger = logger.child({ stepId: step.id });
    const dispatchCtx: StepDispatchContext = {
      flow,
      runDir,
      runId,
      flowName: flow.name,
      flowDir,
      stepId: step.id,
      attempt,
      abortSignal: abortController.signal,
      handoffStore,
      costTracker,
      stateMachine,
      logger: stepLogger,
      providers,
      provider,
      providerByStep,
      inputVars,
      ...(invocationCwd !== undefined ? { cwd: invocationCwd } : {}),
      ...(verbose !== undefined ? { verbose } : {}),
      dispatchStep: (branchStepId) => dispatchStep(branchStepId),
      dispatchBodyStep: (bodyStepId, bodyStep, loopIter, loopStepId) =>
        runBodyStep(bodyStepId, bodyStep, loopIter, loopStepId),
      getBranchStatus,
      getBranchResult: (branchStepId) => stateMachine.getStepResult(branchStepId),
      getResumedLoopIter,
      onLoopIterationStart,
      isLoopBodyStepSucceeded,
      signalSiblingFailureAbort: (branchStepId) => {
        signalSiblingFailureAbort({ kind: 'sibling-failure', stepId: branchStepId });
      },
    };

    const entry = defaultStepRegistry.get(step.kind);
    if (entry === undefined) {
      throw new FlowDefinitionError(
        `unknown step kind "${step.kind}" for step "${step.id}". Register it via defaultStepRegistry.register(...) before running the flow.`,
        { stepId: step.id },
      );
    }
    // The registry stores entries keyed by literal kind, so the entry's
    // execute signature is precisely typed for `step.kind`. The cast on
    // `step` re-narrows the broad union to the matching variant —
    // TypeScript cannot follow the discriminant through the registry's
    // heterogeneous map.
    return entry.execute(step as never, dispatchCtx);
  };

  /**
   * Dispatch a single body step inside a loop iteration. Every body-step
   * kind gets a synthesised state entry keyed by
   * `<loopStepId>::<bodyStepId>` so resume can short-circuit body steps
   * that already succeeded on a prior pass — without this, prompt/script
   * body steps re-run on every pause-resume cycle, re-spending tokens
   * and possibly producing a different handoff than the prior pass.
   *
   * The body step's executor runs with attempt=1; the loop's iteration
   * cycle is the recovery boundary for body-step failures (the parent
   * loop step's own retry budget governs whole-iteration retries).
   *
   * Ask body steps still need their special-case handling: they can
   * throw AwaitingInputSignal to pause the run, so on that path the
   * synthesised key is stamped onto the signal's stepId and
   * loopContext is attached. The outer dispatch catch then calls
   * pauseStep on an entry the StateMachine recognises and threads the
   * loop pointer onto the awaitingInput record.
   */
  const runBodyStep = async (
    bodyStepId: string,
    bodyStep: Step,
    loopIter: number,
    loopStepId: string,
  ): Promise<StepResult> => {
    const synthesisedKey = StateMachine.bodyStepStateKey(loopStepId, bodyStepId);

    const seedResult = stateMachine.seedBodyStep(loopStepId, bodyStepId, loopIter);
    if (seedResult.isErr()) throw seedResult.error;
    const startResult = stateMachine.startStep(synthesisedKey);
    if (startResult.isErr()) throw startResult.error;

    try {
      // Ask body steps drive executeAsk directly so the iteration-scoped
      // answer-file path can be wired through. Other kinds delegate to
      // runExecutor — same path top-level steps take, with attempt=1.
      let result: StepResult;
      if (bodyStep.kind === 'ask') {
        const askResult = await executeAsk(
          bodyStep,
          handoffStore,
          bodyStep.id,
          runDir,
          askIterationAnswerHandoffPath(runDir, loopStepId, loopIter, bodyStepId),
        );
        if (askResult.isErr()) throw askResult.error;
        const answers = askResult.value;
        const writeResult = await handoffStore.write<unknown>(
          bodyStep.id,
          answers,
          bodyStep.output?.schema,
        );
        if (writeResult.isErr()) throw writeResult.error;
        const askStepResult: AskStepResult = {
          kind: 'ask',
          stepId: bodyStep.id,
          answers,
          handoffs: [bodyStep.id],
        };
        result = askStepResult;
      } else {
        result = await runExecutor(bodyStep, 1);
      }

      const completeResult = stateMachine.completeStep(
        synthesisedKey,
        stepCompletionOutput(result),
      );
      if (completeResult.isErr()) throw completeResult.error;
      const completeSave = await stateMachine.save();
      if (completeSave.isErr()) {
        logger.error(
          { event: 'state.save_failed', error: completeSave.error.message },
          'state.json atomic write failed after loop body step completed',
        );
        throw completeSave.error;
      }

      return result;
    } catch (caught) {
      if (isAwaitingInputSignal(caught)) {
        // Re-target the signal at the synthesised body-step state key so
        // the outer dispatch catch can call pauseStep on an entry the
        // StateMachine recognises. Attach loopContext so the catch knows
        // to thread loopStepId/loopIter onto the awaitingInput record.
        // The synthesised entry is currently 'running'; pauseStep will
        // flip it to 'paused' from there.
        caught.stepId = synthesisedKey;
        caught.loopContext = { loopStepId, loopIter };
        throw caught;
      }
      if (!isAbortLike(caught)) {
        // Non-abort body-step failures fail the synthesised entry so the
        // iteration sweep at the next iteration boundary lands it back
        // on pending (or, for body steps that the parent loop's retry
        // budget surfaces here, resetStep can pick the entry up). Save
        // is fire-and-forget on this path — the throw below escalates
        // to dispatchStep which performs its own save before unwinding.
        const failResult = stateMachine.failStep(synthesisedKey, errorMessageOf(caught));
        if (failResult.isErr()) {
          logger.error(
            {
              event: 'state.transition_failed',
              stepId: synthesisedKey,
              error: failResult.error.message,
            },
            'state transition failed after loop body step failure',
          );
        }
      }
      throw caught;
    }
  };

  const dispatchStep = async (stepId: string): Promise<StepResult> => {
    const step = flow.steps[stepId];
    if (step === undefined) {
      throw new FlowDefinitionError(`unknown step id "${stepId}"`);
    }

    // inflight lifecycle is fully contained in this try/finally so the slot
    // is released regardless of which step of the dispatch pipeline throws
    // (startStep transition, startSave, executor, or completeStep). Without
    // the outer try/finally, a throw before entering an inner try would leak
    // the slot and the walker's queue would hang on a phantom in-flight
    // count. inflight is managed here (not by the walker) so steps
    // dispatched as parallel branches remove themselves on completion; the
    // walker's drain loop only observes the slot count to gate parallelism.

    inflight.add(stepId);
    try {
      // Snapshot before startStep increments attempts so remainingRetries is
      // clamped against attempts already consumed in prior run cycles
      // (including runs that crashed before markRun fired).
      const priorAttempts = stateMachine.getState().steps[stepId]?.attempts ?? 0;

      const startResult = stateMachine.startStep(stepId);
      if (startResult.isErr()) throw startResult.error;

      const { maxRetries, timeoutMs } = stepRetryBudget(step);
      // Clamp: a step that has already consumed its full budget on a prior run
      // must not receive additional retries on resume. remainingRetries is zero
      // when priorAttempts >= maxRetries.
      const remainingRetries = Math.max(0, maxRetries - priorAttempts);

      const startSave = await stateMachine.save();
      if (startSave.isErr()) {
        logger.error(
          { event: 'state.save_failed', error: startSave.error.message },
          'state.json atomic write failed',
        );
        throw startSave.error;
      }

      void writeLiveState(runDir, stepId, {
        status: 'running',
        attempt: stateMachine.getState().steps[stepId]?.attempts ?? 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      });

      try {
        const value = await raceAbort(
          withRetry((attempt) => runExecutor(step, attempt), {
            maxRetries: remainingRetries,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            logger,
            stepId,
          }),
        );
        const completeResult = stateMachine.completeStep(stepId, stepCompletionOutput(value));
        if (completeResult.isErr()) throw completeResult.error;
        stateMachine.recordStepResult(stepId, value);
        const succeededState = stateMachine.getState().steps[stepId];
        void writeLiveState(runDir, stepId, {
          status: 'succeeded',
          attempt: succeededState?.attempts ?? 1,
          startedAt: succeededState?.startedAt ?? new Date().toISOString(),
          lastUpdateAt: new Date().toISOString(),
        });
        return value;
      } catch (caught) {
        if (isAwaitingInputSignal(caught)) {
          await handlePause(stepId, caught);
          throw caught;
        }
        if (!isAbortLike(caught)) {
          const failResult = stateMachine.failStep(stepId, errorMessageOf(caught));
          if (failResult.isErr()) {
            logger.error(
              {
                event: 'state.transition_failed',
                stepId,
                error: failResult.error.message,
              },
              'state transition failed after step failure',
            );
          }
          const failedState = stateMachine.getState().steps[stepId];
          void writeLiveState(runDir, stepId, {
            status: 'failed',
            attempt: failedState?.attempts ?? 1,
            startedAt: failedState?.startedAt ?? new Date().toISOString(),
            lastUpdateAt: new Date().toISOString(),
          });
        }
        // Abort leaves the step in running state; markRun('aborted') sweeps
        // it to failed with a descriptive errorMessage so on-disk state is
        // never stuck in running after SIGINT.
        throw caught;
      }
    } finally {
      inflight.delete(stepId);
    }
  };

  /**
   * Transition the paused step from running to paused, persist atomically,
   * sweep any sibling parallel branches that were mid-flight, then trip the
   * run-wide abort so the walker treats the next iteration as the paused
   * outcome. The signal itself is re-thrown by the caller so the walker's
   * completion loop recognises this as the paused outcome instead of a
   * failure.
   *
   * When the paused step lives inside a loop body, runBodyStep attached
   * loopContext on the signal — thread it onto the awaitingInput record so
   * resume can re-enter the loop at the same iteration without the CLI
   * needing to inspect the synthesised state-key shape.
   */
  const handlePause = async (stepId: string, caught: AwaitingInputSignal): Promise<void> => {
    const promptedAt = new Date().toISOString();
    const pauseResult = stateMachine.pauseStep(
      caught.stepId,
      caught.questions,
      promptedAt,
      caught.loopContext?.loopStepId,
      caught.loopContext?.loopIter,
    );
    if (pauseResult.isErr()) {
      logger.error(
        {
          event: 'state.transition_failed',
          stepId,
          error: pauseResult.error.message,
        },
        'state transition failed while pausing step',
      );
    }
    // Sibling parallel branches that were mid-flight when this ask
    // step paused must not be left at status 'running' on disk —
    // the resume seeder only re-queues 'pending'/'paused'/'failed'
    // steps, so a zombie 'running' entry would deadlock the run.
    // Sweep every running sibling back to pending here so the
    // single save() below persists a clean snapshot atomically.
    // The failStep -> resetStep chain preserves attempts; the
    // matching decrementAttempts call after each reset rolls the
    // counter back by one so the swept dispatch (which never ran
    // its executor to completion) is no longer counted. Without
    // the decrement the next dispatch's startStep increments
    // attempts a second time per pause cycle, eroding the
    // configured retry budget by one cycle each pass.
    const pausingStepId = caught.stepId;
    for (const [siblingId, siblingState] of Object.entries(stateMachine.getState().steps)) {
      if (siblingState.status !== 'running') continue;
      if (siblingId === pausingStepId) continue;
      const failSibling = stateMachine.failStep(siblingId, 'aborted by sibling pause');
      if (failSibling.isErr()) {
        logger.error(
          {
            event: 'state.transition_failed',
            stepId: siblingId,
            error: failSibling.error.message,
          },
          'state transition failed while sweeping sibling on pause',
        );
        continue;
      }
      const resetSibling = stateMachine.resetStep(siblingId);
      if (resetSibling.isErr()) {
        logger.error(
          {
            event: 'state.transition_failed',
            stepId: siblingId,
            error: resetSibling.error.message,
          },
          'state transition failed while sweeping sibling on pause',
        );
        continue;
      }
      const decrementSibling = stateMachine.decrementAttempts(siblingId);
      if (decrementSibling.isErr()) {
        logger.error(
          {
            event: 'state.transition_failed',
            stepId: siblingId,
            error: decrementSibling.error.message,
          },
          'state transition failed while compensating sibling attempts',
        );
        continue;
      }
      logger.debug(
        { event: 'run.paused.sibling_reset', id: siblingId },
        'sibling step swept to pending on pause',
      );
    }
    const pauseSave = await stateMachine.save();
    if (pauseSave.isErr()) {
      logger.error(
        { event: 'state.save_failed', error: pauseSave.error.message },
        'state.json atomic write failed',
      );
      throw pauseSave.error;
    }
    const pausedState = stateMachine.getState().steps[stepId];
    void writeLiveState(runDir, stepId, {
      status: 'paused',
      attempt: pausedState?.attempts ?? 1,
      startedAt: pausedState?.startedAt ?? new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
    });
    logger.info(
      {
        event: 'run.paused',
        stepId: caught.stepId,
        questionCount: caught.questions.length,
      },
      'run paused for human input',
    );
    signalPause(caught);
    abortController.abort();
  };

  return {
    dispatchStep,
    inflightSize: () => inflight.size,
  };
}

/**
 * Per-step retry budget + timeout. Schema-bound prompts default to a single
 * retry: the OUTPUT CONTRACT helper-script round-trip absorbs most failures
 * inside one invocation, but a model that gives up mid-loop still gets one
 * more attempt at the orchestrator level. Other prompt shapes keep the
 * historical "no retry" default so the change is opt-in via schema.
 */
export function stepRetryBudget(step: Step): { maxRetries: number; timeoutMs: number | undefined } {
  if (step.kind === 'prompt') {
    const hasSchemaContract = 'handoff' in step.output && step.output.schema !== undefined;
    // Backstop for the default prompt timeout. The schema applies the same value
    // when authors run their flow through step.prompt(...), but the Orchestrator
    // also accepts hand-built PromptStepSpec literals; without this fallback
    // a runaway invocation could stream tokens indefinitely.
    return {
      maxRetries: step.maxRetries ?? (hasSchemaContract ? 1 : 0),
      timeoutMs: step.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    };
  }
  if (step.kind === 'script' || step.kind === 'branch') {
    return { maxRetries: step.maxRetries ?? 0, timeoutMs: step.timeoutMs };
  }
  if (step.kind === 'loop') {
    return { maxRetries: step.maxRetries ?? 0, timeoutMs: undefined };
  }
  return { maxRetries: 0, timeoutMs: undefined };
}

/**
 * PromptStepResult tracks handoffs (keys produced via output.handoff) and
 * artifacts (file paths produced via output.artifact) as independent arrays.
 * completeStep persists both projections on StepState verbatim so
 * RunResult.artifacts surfaces every file the step produced and resume can
 * introspect which handoffs landed without re-reading them.
 *
 * AskStepResult records the answer handoff key under `handoffs` so the
 * produced answer map is discoverable from StepState the same way a
 * prompt step's handoffs are. Ask steps never write artifacts.
 */
export function stepCompletionOutput(result: StepResult): {
  handoffs?: readonly string[];
  artifacts?: readonly string[];
} {
  if (typeof result !== 'object' || result === null || !('kind' in result)) {
    return {};
  }
  if (result.kind === 'prompt') {
    return { handoffs: result.handoffs, artifacts: result.artifacts };
  }
  if (result.kind === 'ask') {
    return { handoffs: result.handoffs };
  }
  return {};
}

export function stepOnFail(step: Step): 'abort' | 'continue' | string {
  if (step.kind === 'terminal' || step.kind === 'ask') return 'abort';
  return step.onFail ?? 'abort';
}
