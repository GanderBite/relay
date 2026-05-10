import { join } from 'node:path';
import { FlowDefinitionError, HandoffNotFoundError, LoopMaxIterationsError } from '../../errors.js';
import type { LoopStepSpec, Step } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import type { Logger } from '../../logger.js';
import type { StepResult } from '../types.js';

export interface LoopStepResult {
  kind: 'loop';
  loopStepId: string;
  iterations: number;
  body: Record<string, unknown>;
}

/**
 * Context bag threaded into executeLoop. The orchestrator constructs this
 * from its StepExecutionContext plus a `dispatch` closure that drives a
 * single body step — the closure handles state transitions, retries, and
 * provider invocation, so the loop executor itself only owns the iteration
 * cycle, the iteration-scoped handoff promotion, and the until-condition
 * check.
 */
export interface LoopExecutorContext {
  runDir: string;
  stepId: string;
  abortSignal: AbortSignal;
  handoffStore: HandoffStore;
  logger: Logger;
  /**
   * Dispatch one body step at a given iteration. The closure is owned by the
   * orchestrator and re-uses the existing per-step execution path (state
   * transitions, retries, executor selection). The loop executor calls it
   * once per body step per iteration.
   */
  dispatch: (bodyStepId: string, bodyStep: Step, loopIter: number) => Promise<StepResult>;
  /**
   * Optional hook invoked at the top of every iteration (after the abort
   * check, before any body step dispatch). Lets the caller persist the
   * current iteration to durable state so a mid-iteration crash can be
   * resumed. Absent in callers that have no resume-aware state to update.
   */
  onIterationStart?: (iter: number) => Promise<void>;
  /**
   * Optional hook called once before the loop starts. Returns the iteration
   * to resume from when the prior run paused mid-loop, or undefined to start
   * fresh from iteration 1. The returned value is clamped only by the loop's
   * configured maxIterations — out-of-range values exit the loop immediately
   * via the for-loop bound.
   */
  getResumedIter?: () => number | undefined;
  /**
   * Optional predicate invoked before every body-step dispatch. Returns true
   * when the body step already succeeded in this iteration on a prior run
   * and the dispatch should be skipped. When skipped, the loop reads any
   * iteration-scoped handoffs the prior run produced for this body step so
   * the iteration's handoff set still tracks what materialised.
   */
  isBodyStepSucceeded?: (loopStepId: string, bodyStepId: string, iter: number) => boolean;
}

/**
 * Recursively collects handoff names produced by a body step's StepResult.
 * Prompt steps carry a flat `handoffs: string[]`; parallel steps fan out to
 * branch StepResults whose handoffs need to be reachable through the same
 * promotion path. Script, branch, and terminal results never produce
 * handoffs and contribute nothing.
 */
function collectHandoffNames(result: StepResult): string[] {
  if ('kind' in result && result.kind === 'prompt') {
    return [...result.handoffs];
  }
  if ('kind' in result && result.kind === 'parallel') {
    const names: string[] = [];
    for (const branchResult of Object.values(result.branches)) {
      if (isStepResult(branchResult)) {
        names.push(...collectHandoffNames(branchResult));
      }
    }
    return names;
  }
  return [];
}

/**
 * Type guard for StepResult — parallel step branch results are typed as
 * unknown on the wire (the executor accepts any dispatch return), so the
 * recursive walker narrows back through this guard.
 */
function isStepResult(value: unknown): value is StepResult {
  if (typeof value !== 'object' || value === null) return false;
  if ('kind' in value) {
    const kind = (value as { kind: unknown }).kind;
    return kind === 'prompt' || kind === 'parallel' || kind === 'terminal' || kind === 'loop';
  }
  // Script/branch results predate the kind discriminator and carry exitCode.
  return 'exitCode' in value;
}

function newAbortError(): Error {
  const err = new Error('run aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Recursive deep-equal comparison used by the until-condition check.
 * Primitives compare with strict equality; arrays compare elementwise; plain
 * objects compare by own keys with the same values. Anything else (Map, Set,
 * Date, class instance) falls back to strict equality, which is the intended
 * conservative behaviour for the until pattern's typed-as-Record<string, unknown>.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bRec, key)) return false;
    if (!deepEqual(aRec[key], bRec[key])) return false;
  }
  return true;
}

/**
 * Evaluates the until.when pattern against a value read from the latest
 * pointer. The pattern is satisfied iff `value` is an object containing each
 * key in `pattern` whose stored value deep-equals the pattern entry. Null,
 * undefined, primitive, and array values can never satisfy the pattern.
 */
function untilSatisfied(value: unknown, pattern: Record<string, unknown>): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(pattern)) {
    if (!Object.hasOwn(record, key)) return false;
    if (!deepEqual(record[key], expected)) return false;
  }
  return true;
}

/**
 * Discriminated state for the loop iteration cycle. Each transition method
 * on LoopIterationStateMachine asserts the prior state and moves to the
 * next, surfacing illegal transitions as thrown errors so a bug in the
 * driver surfaces loudly instead of silently producing the wrong result.
 *
 *   idle
 *     └─[start]──> iterating
 *                    ├─[abort observed]──> aborted
 *                    ├─[iter > maxIterations]──> exhausted
 *                    └─[startIteration]──> body-dispatching
 *                                            ├─[abort observed]──> aborted
 *                                            ├─[recordBodyStepSuccess]──> body-dispatching
 *                                            ├─[recordBodyStepSkipped]──> body-dispatching
 *                                            └─[finishIteration]──> until-checking
 *                                                                    ├─[abort observed]──> aborted
 *                                                                    ├─[evaluateUntil match]──> done
 *                                                                    └─[evaluateUntil miss]──> iterating
 */
type LoopState =
  | { kind: 'idle' }
  | { kind: 'iterating'; nextIter: number }
  | { kind: 'body-dispatching'; iter: number; iterHandoffs: string[] }
  | { kind: 'until-checking'; iter: number; iterHandoffs: string[] }
  | { kind: 'exhausted'; iterationsCompleted: number }
  | { kind: 'aborted' }
  | {
      kind: 'done';
      iterations: number;
      lastIterationHandoffs: readonly string[];
    };

/**
 * Drives the loop iteration lifecycle through explicit state transitions.
 * Owned and called only by `executeLoop` in this file; not exported.
 *
 * The machine itself is pure — it does not call dispatch, write to the
 * handoff store, or consult the abort signal. The driver (executeLoop)
 * performs side effects between transitions and feeds the resulting data
 * back in via the appropriate `record*` / `evaluateUntil` calls. This keeps
 * the iteration cycle individually testable and makes each of the 11
 * edge-case branches of the loop a named transition.
 */
class LoopIterationStateMachine {
  #state: LoopState = { kind: 'idle' };
  readonly #maxIterations: number;
  #iterationsCompleted = 0;
  // Tracks every handoff name produced by any body step on the most recent
  // iteration, so the returned `body` map reflects what actually
  // materialised — including handoffs nested inside parallel body steps —
  // rather than only the names statically declared on prompt-step specs.
  #lastIterationHandoffs: readonly string[] = [];

  constructor(maxIterations: number) {
    this.#maxIterations = maxIterations;
  }

  get state(): LoopState['kind'] {
    return this.#state.kind;
  }

  /**
   * Transition idle → iterating. Sets the next iteration index that
   * `startIteration` expects to receive. Called once at the top of the
   * loop with the resume-or-1 starting iteration.
   */
  start(startIter: number): void {
    if (this.#state.kind !== 'idle') {
      throw new Error(`LoopIterationStateMachine.start called in state ${this.#state.kind}`);
    }
    this.#state = { kind: 'iterating', nextIter: startIter };
  }

  /**
   * Transition iterating → body-dispatching. Driver passes the iteration
   * number it intends to run; the machine validates it matches `nextIter`
   * and seeds an empty per-iteration handoff list for the body steps to
   * append to via the `record*` methods.
   */
  startIteration(iter: number): void {
    if (this.#state.kind !== 'iterating') {
      throw new Error(
        `LoopIterationStateMachine.startIteration called in state ${this.#state.kind}`,
      );
    }
    if (iter !== this.#state.nextIter) {
      throw new Error(
        `LoopIterationStateMachine.startIteration expected iter ${this.#state.nextIter}, got ${iter}`,
      );
    }
    this.#state = { kind: 'body-dispatching', iter, iterHandoffs: [] };
  }

  /**
   * Records that a body step produced the given handoff names on the
   * current iteration. Called after a successful dispatch; the caller
   * has already promoted the values into the iteration namespace and
   * updated the latest pointer.
   */
  recordBodyStepSuccess(_bodyStepId: string, handoffNames: readonly string[]): void {
    if (this.#state.kind !== 'body-dispatching') {
      throw new Error(
        `LoopIterationStateMachine.recordBodyStepSuccess called in state ${this.#state.kind}`,
      );
    }
    this.#state.iterHandoffs.push(...handoffNames);
  }

  /**
   * Records that a body step's dispatch was skipped because the resume
   * predicate reported it as already-succeeded. The caller passes the
   * iteration-handoff names that were successfully replayed from disk;
   * names whose iteration files are missing or corrupt are not passed.
   */
  recordBodyStepSkipped(_bodyStepId: string, replayedHandoffNames: readonly string[]): void {
    if (this.#state.kind !== 'body-dispatching') {
      throw new Error(
        `LoopIterationStateMachine.recordBodyStepSkipped called in state ${this.#state.kind}`,
      );
    }
    this.#state.iterHandoffs.push(...replayedHandoffNames);
  }

  /**
   * Transition body-dispatching → until-checking. All body steps for the
   * current iteration have completed (or been skipped); the machine now
   * awaits an `evaluateUntil` call from the driver.
   */
  finishIteration(): void {
    if (this.#state.kind !== 'body-dispatching') {
      throw new Error(
        `LoopIterationStateMachine.finishIteration called in state ${this.#state.kind}`,
      );
    }
    this.#iterationsCompleted = this.#state.iter;
    this.#lastIterationHandoffs = [...this.#state.iterHandoffs];
    this.#state = {
      kind: 'until-checking',
      iter: this.#state.iter,
      iterHandoffs: this.#state.iterHandoffs,
    };
  }

  /**
   * Transition until-checking → done (match) or → iterating (miss).
   * The driver supplies the resolved match/miss result; the machine
   * never reads the handoff store itself.
   */
  evaluateUntil(matched: boolean): void {
    if (this.#state.kind !== 'until-checking') {
      throw new Error(
        `LoopIterationStateMachine.evaluateUntil called in state ${this.#state.kind}`,
      );
    }
    if (matched) {
      this.#state = {
        kind: 'done',
        iterations: this.#state.iter,
        lastIterationHandoffs: [...this.#state.iterHandoffs],
      };
      return;
    }
    const next = this.#state.iter + 1;
    if (next > this.#maxIterations) {
      this.#state = { kind: 'exhausted', iterationsCompleted: this.#iterationsCompleted };
      return;
    }
    this.#state = { kind: 'iterating', nextIter: next };
  }

  /**
   * Transition any non-terminal state → aborted. Called when the driver
   * observes the abort signal between transitions. After this, only
   * getResult() is meaningful and it returns undefined (signalling the
   * driver to throw an AbortError).
   */
  abort(): void {
    this.#state = { kind: 'aborted' };
  }

  /**
   * Returns true when the state machine has reached a terminal state
   * (done, exhausted, or aborted). The driver's main loop exits when
   * this returns true.
   */
  isTerminal(): boolean {
    return (
      this.#state.kind === 'done' ||
      this.#state.kind === 'exhausted' ||
      this.#state.kind === 'aborted'
    );
  }

  /**
   * When the machine is in the `iterating` terminal-checked state, returns
   * the iteration number the driver should start next. Returns undefined
   * in every other state — the driver should never call this except after
   * `start()` or after `evaluateUntil(false)` left the machine in
   * `iterating`.
   */
  nextIter(): number | undefined {
    return this.#state.kind === 'iterating' ? this.#state.nextIter : undefined;
  }

  /** Snapshot used by the driver to log structured payloads. */
  iterationsCompleted(): number {
    return this.#iterationsCompleted;
  }

  lastIterationHandoffs(): readonly string[] {
    return this.#lastIterationHandoffs;
  }

  /**
   * Returns the success result when the machine reached `done`, or
   * undefined otherwise. The driver inspects this after every transition
   * and either returns the result, throws AbortError (state `aborted`),
   * or throws LoopMaxIterationsError (state `exhausted`).
   */
  getResult(): { iterations: number; lastIterationHandoffs: readonly string[] } | undefined {
    if (this.#state.kind === 'done') {
      return {
        iterations: this.#state.iterations,
        lastIterationHandoffs: this.#state.lastIterationHandoffs,
      };
    }
    return undefined;
  }

  /** True when the machine reached the exhaustion terminal. */
  isExhausted(): boolean {
    return this.#state.kind === 'exhausted';
  }

  /** True when the machine was aborted between transitions. */
  isAborted(): boolean {
    return this.#state.kind === 'aborted';
  }
}

/**
 * Drives the loop iteration cycle. For each iteration the body steps run in
 * topological order through the dispatch closure; on success each handoff
 * the step produced is copied into the iteration-scoped path and promoted
 * to the latest pointer. After every iteration the until condition is
 * evaluated against the latest pointer; the loop exits when the condition
 * matches or throws LoopMaxIterationsError when the configured ceiling is
 * reached without a match.
 *
 * Resume semantics: the loop starts at iteration 1 unless the optional
 * getResumedIter hook returns a higher value, in which case the loop picks
 * up at the paused iteration and skips body steps the optional
 * isBodyStepSucceeded hook reports as already completed in that iteration.
 * Iteration-scoped handoff files on disk remain the source of truth for
 * cross-iteration state.
 */
export async function executeLoop(
  step: LoopStepSpec,
  ctx: LoopExecutorContext,
): Promise<LoopStepResult> {
  if (step.bodyGraph === undefined) {
    throw new FlowDefinitionError(`loop step "${step.id}" is missing a compiled body graph`, {
      stepId: step.id,
    });
  }

  const bodyGraph = step.bodyGraph;
  const topoOrder = bodyGraph.topoOrder;
  const maxIterations = step.maxIterations;

  ctx.logger.info(
    {
      event: 'loop.start',
      stepId: step.id,
      maxIterations,
      bodySteps: topoOrder.length,
    },
    'loop step started',
  );

  const machine = new LoopIterationStateMachine(maxIterations);
  const startIter = ctx.getResumedIter?.() ?? 1;
  machine.start(startIter);

  while (!machine.isTerminal()) {
    const iter = machine.nextIter();
    if (iter === undefined) break;
    if (iter > maxIterations) {
      // Resume hook returned an out-of-range iteration; surface as exhausted
      // via the state machine to keep the throw path uniform.
      machine.evaluateUntil(false);
      break;
    }

    if (ctx.abortSignal.aborted) {
      machine.abort();
      break;
    }

    await ctx.onIterationStart?.(iter);

    ctx.logger.info(
      { event: 'loop.iteration.start', stepId: step.id, iter },
      'loop iteration started',
    );

    machine.startIteration(iter);

    let abortedDuringBody = false;
    for (const bodyStepId of topoOrder) {
      if (ctx.abortSignal.aborted) {
        machine.abort();
        abortedDuringBody = true;
        break;
      }

      const bodyStep = step.body[bodyStepId];
      if (bodyStep === undefined) {
        throw new FlowDefinitionError(
          `loop step "${step.id}" body is missing step "${bodyStepId}" referenced by its body graph`,
          { stepId: step.id },
        );
      }

      // When the optional resume hook reports this body step already
      // succeeded in this iteration, skip the dispatch and reconstruct the
      // iteration's handoff names from the body-step spec so the until
      // condition and final body map see the same set the original run
      // produced. A missing iteration file is the expected case for body
      // step kinds that may produce no handoff (e.g. a script step with
      // no output.handoff) — we silently omit it. Any other read error
      // (I/O failure, schema mismatch, invalid id) signals that a handoff
      // the prior run wrote can no longer be loaded; we surface that as a
      // warn-level breadcrumb so the operator sees the corruption instead
      // of letting the until condition silently diverge.
      if (ctx.isBodyStepSucceeded?.(step.id, bodyStepId, iter) === true) {
        ctx.logger.debug(
          {
            event: 'loop.body_step.skipped',
            stepId: step.id,
            bodyStepId,
            iter,
          },
          'loop body step already succeeded in this iteration; skipping dispatch',
        );

        const skippedHandoffNames: string[] = [];
        if (bodyStep.kind === 'prompt' && 'handoff' in bodyStep.output) {
          skippedHandoffNames.push(bodyStep.output.handoff);
        } else if (bodyStep.kind === 'ask') {
          skippedHandoffNames.push(bodyStep.id);
        }

        const replayed: string[] = [];
        for (const name of skippedHandoffNames) {
          const readResult = await ctx.handoffStore.readIteration(step.id, iter, name);
          if (readResult.isOk()) {
            replayed.push(name);
          } else if (!(readResult.error instanceof HandoffNotFoundError)) {
            ctx.logger.warn(
              {
                event: 'loop.iteration.replay_failed',
                stepId: step.id,
                bodyStepId,
                iter,
                name,
                errorName: readResult.error.name,
                error: readResult.error.message,
              },
              'iteration handoff replay failed; the until condition may diverge',
            );
          }
        }
        machine.recordBodyStepSkipped(bodyStepId, replayed);
        continue;
      }

      const bodyResult = await ctx.dispatch(bodyStepId, bodyStep, iter);

      // Promote each handoff the body step produced into the iteration
      // namespace, then update the latest pointer. The body step has already
      // written the value to the flat handoff path; reading it back keeps
      // the executor agnostic to the body step's kind.
      const handoffNames = collectHandoffNames(bodyResult);
      for (const name of handoffNames) {
        const readResult = await ctx.handoffStore.read(name);
        if (readResult.isErr()) throw readResult.error;
        const writeResult = await ctx.handoffStore.writeIteration(
          step.id,
          iter,
          name,
          readResult.value,
        );
        if (writeResult.isErr()) throw writeResult.error;
        const promoteResult = await ctx.handoffStore.promoteIteration(step.id, iter, name);
        if (promoteResult.isErr()) throw promoteResult.error;
      }
      machine.recordBodyStepSuccess(bodyStepId, handoffNames);
    }

    if (abortedDuringBody) break;

    if (ctx.abortSignal.aborted) {
      machine.abort();
      break;
    }

    machine.finishIteration();

    // Evaluate the until condition against the named source's latest pointer.
    // A missing pointer (the named step never wrote that handoff) is treated
    // as a non-match so the loop continues until the ceiling forces an exit.
    const latestResult = await ctx.handoffStore.readLatest(step.id, step.until.from);
    let matched = false;
    if (latestResult.isErr()) {
      ctx.logger.debug(
        {
          event: 'loop.until.read_failed',
          stepId: step.id,
          iter,
          from: step.until.from,
          error: latestResult.error.message,
        },
        'loop until source not available; continuing',
      );
    } else if (untilSatisfied(latestResult.value, step.until.when)) {
      matched = true;
    }

    if (matched) {
      ctx.logger.info(
        { event: 'loop.until.matched', stepId: step.id, iter, from: step.until.from },
        'loop until condition matched',
      );
    }

    machine.evaluateUntil(matched);
  }

  if (machine.isAborted()) {
    throw newAbortError();
  }

  const result = machine.getResult();
  if (result !== undefined) {
    const finalBody = await readFinalBody(
      ctx.handoffStore,
      step.id,
      result.iterations,
      result.lastIterationHandoffs,
    );
    ctx.logger.info(
      { event: 'loop.done', stepId: step.id, iterations: result.iterations },
      'loop step completed',
    );
    return {
      kind: 'loop',
      loopStepId: step.id,
      iterations: result.iterations,
      body: finalBody,
    };
  }

  throw new LoopMaxIterationsError(
    `loop step "${step.id}" exhausted ${maxIterations} iterations without until condition matching`,
    step.id,
    maxIterations,
    machine.iterationsCompleted(),
    {
      loopStepId: step.id,
      maxIterations,
      iterationsRun: machine.iterationsCompleted(),
      handoffsDir: join(ctx.runDir, 'handoffs', step.id),
    },
  );
}

/**
 * Builds the final iteration's handoff map for the LoopStepResult. The map
 * is keyed by handoff name and carries the parsed value read from the
 * iteration-scoped path. The set of names is captured at dispatch time so
 * handoffs nested inside parallel body steps are included alongside the
 * top-level prompt-step handoffs. A missing iteration file is silently
 * omitted — the caller sees only handoffs that materialised.
 */
async function readFinalBody(
  handoffStore: HandoffStore,
  loopStepId: string,
  iter: number,
  handoffNames: readonly string[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of handoffNames) {
    const readResult = await handoffStore.readIteration(loopStepId, iter, name);
    if (readResult.isOk()) {
      out[name] = readResult.value;
    }
  }
  return out;
}
