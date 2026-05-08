import type { CostTracker } from '../../cost.js';
import { FlowDefinitionError, LoopMaxIterationsError } from '../../errors.js';
import type { LoopStepSpec, Step } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import type { Logger } from '../../logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import type { StateMachine } from '../../state.js';
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
 * check. The provider/providers fields mirror the prompt executor's bag for
 * symmetry; the loop executor does not invoke providers directly.
 */
export interface LoopExecutorContext {
  runDir: string;
  runId: string;
  flowDir: string;
  flowName: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  logger: Logger;
  provider: Provider;
  providers: ProviderRegistry;
  /**
   * Dispatch one body step at a given iteration. The closure is owned by the
   * orchestrator and re-uses the existing per-step execution path (state
   * transitions, retries, executor selection). The loop executor calls it
   * once per body step per iteration.
   */
  dispatch: (bodyStepId: string, bodyStep: Step, loopIter: number) => Promise<StepResult>;
  inputVars?: Record<string, unknown> | undefined;
  cwd?: string | undefined;
  verbose?: boolean | undefined;
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
 * Drives the loop iteration cycle. For each iteration the body steps run in
 * topological order through the dispatch closure; on success each handoff
 * the step produced is copied into the iteration-scoped path and promoted
 * to the latest pointer. After every iteration the until condition is
 * evaluated against the latest pointer; the loop exits when the condition
 * matches or throws LoopMaxIterationsError when the configured ceiling is
 * reached without a match.
 *
 * Resume semantics: the orchestrator resets the loop step to pending on
 * resume so iterations always start from 1. No nested per-iteration state is
 * persisted; the iteration-scoped handoff files on disk are the only record.
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

  let iterationsCompleted = 0;
  // Tracks every handoff name produced by any body step on the most recent
  // iteration, so the returned `body` map reflects what actually
  // materialised — including handoffs nested inside parallel body steps —
  // rather than only the names statically declared on prompt-step specs.
  let lastIterationHandoffs: string[] = [];

  for (let iter = 1; iter <= maxIterations; iter += 1) {
    if (ctx.abortSignal.aborted) {
      throw newAbortError();
    }

    ctx.logger.info(
      { event: 'loop.iteration.start', stepId: step.id, iter },
      'loop iteration started',
    );

    const iterHandoffs: string[] = [];
    for (const bodyStepId of topoOrder) {
      if (ctx.abortSignal.aborted) {
        throw newAbortError();
      }

      const bodyStep = step.body[bodyStepId];
      if (bodyStep === undefined) {
        throw new FlowDefinitionError(
          `loop step "${step.id}" body is missing step "${bodyStepId}" referenced by its body graph`,
          { stepId: step.id },
        );
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
        iterHandoffs.push(name);
      }
    }

    iterationsCompleted = iter;
    lastIterationHandoffs = iterHandoffs;

    if (ctx.abortSignal.aborted) {
      throw newAbortError();
    }

    // Evaluate the until condition against the named source's latest pointer.
    // A missing pointer (the named step never wrote that handoff) is treated
    // as a non-match so the loop continues until the ceiling forces an exit.
    const latestResult = await ctx.handoffStore.readLatest(step.id, step.until.from);
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
      ctx.logger.info(
        { event: 'loop.until.matched', stepId: step.id, iter, from: step.until.from },
        'loop until condition matched',
      );
      const finalBody = await readFinalBody(ctx.handoffStore, step.id, iter, lastIterationHandoffs);
      ctx.logger.info(
        { event: 'loop.done', stepId: step.id, iterations: iter },
        'loop step completed',
      );
      return {
        kind: 'loop',
        loopStepId: step.id,
        iterations: iter,
        body: finalBody,
      };
    }
  }

  throw new LoopMaxIterationsError(
    `loop step "${step.id}" exhausted ${maxIterations} iterations without until condition matching`,
    step.id,
    maxIterations,
    iterationsCompleted,
    {
      loopStepId: step.id,
      maxIterations,
      iterationsRun: iterationsCompleted,
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
