import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CostTracker } from '../cost.js';
import {
  ERROR_CODES,
  FlowDefinitionError,
  PipelineError,
  toFlowDefError,
} from '../errors.js';
import type { Flow, Step } from '../flow/types.js';
import { HandoffStore } from '../handoffs.js';
import { createLogger, type Logger } from '../logger.js';
import { defaultRegistry, ProviderRegistry } from '../providers/registry.js';
import { StateMachine } from '../state.js';
import { atomicWriteJson } from '../util/atomic-write.js';

const DEFAULT_PARALLELISM = 4;
const DEFAULT_PROVIDER_NAME = 'claude';
const FLOW_REF_FILENAME = 'flow-ref.json';
const LIVE_STATE_DIRNAME = 'live';
const METRICS_FILENAME = 'metrics.json';
const RUN_LOG_FILENAME = 'run.log';

export interface RunnerOptions {
  providers?: ProviderRegistry;
  defaultProvider?: string;
  logger?: Logger;
  runDir?: string;
}

export interface RunOptions {
  resumeFrom?: string;
  parallelism?: number;
  liveState?: boolean;
}

export interface RunResult {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
}

/**
 * Context threaded into every per-step executor. Wave-2 executors receive this
 * exact shape; the scaffold constructs and discards one per step.
 */
export interface StepExecutionContext {
  flow: Flow<unknown>;
  runDir: string;
  runId: string;
  flowName: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  logger: Logger;
  providers: ProviderRegistry;
  defaultProvider: string;
  /**
   * Opt-in flag forwarded to ClaudeProvider.authenticate(). Subscription
   * billing stays the default; the Runner only sets this when the caller
   * explicitly invoked Runner.allowApiKey() before run().
   */
  allowApiKey: boolean;
}

function shortRunId(): string {
  return randomBytes(3).toString('hex');
}

function defaultRunDir(runId: string): string {
  return join(process.cwd(), '.relay', 'runs', runId);
}

function errorMessageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * Placeholder step executor. Each arm is replaced by its dedicated executor
 * in the next wave (prompt, script, branch, parallel, terminal). Every arm
 * throws so the scaffold surfaces unmet dependencies as test failures rather
 * than silent successes.
 */
async function executeStep(step: Step, _ctx: StepExecutionContext): Promise<void> {
  switch (step.kind) {
    case 'prompt':
      throw new PipelineError('step executor not implemented', ERROR_CODES.STEP_FAILURE, {
        kind: 'prompt',
      });
    case 'script':
      throw new PipelineError('step executor not implemented', ERROR_CODES.STEP_FAILURE, {
        kind: 'script',
      });
    case 'branch':
      throw new PipelineError('step executor not implemented', ERROR_CODES.STEP_FAILURE, {
        kind: 'branch',
      });
    case 'parallel':
      throw new PipelineError('step executor not implemented', ERROR_CODES.STEP_FAILURE, {
        kind: 'parallel',
      });
    case 'terminal':
      throw new PipelineError('step executor not implemented', ERROR_CODES.STEP_FAILURE, {
        kind: 'terminal',
      });
  }
}

/**
 * Runner orchestrates the execution of a compiled Flow. Construct via
 * `createRunner` (preferred) or `new Runner(opts)`. A single Runner instance
 * may serve multiple sequential `run()` calls; concurrent calls share state
 * and are not supported.
 */
export class Runner {
  readonly #providers: ProviderRegistry;
  readonly #defaultProvider: string;
  readonly #logger: Logger | undefined;
  readonly #runDirOverride: string | undefined;
  #allowApiKey = false;

  constructor(opts: RunnerOptions = {}) {
    this.#providers = opts.providers ?? defaultRegistry;
    this.#defaultProvider = opts.defaultProvider ?? DEFAULT_PROVIDER_NAME;
    this.#logger = opts.logger;
    this.#runDirOverride = opts.runDir;
  }

  /**
   * Opt in to the ANTHROPIC_API_KEY path. When unset (the default), the
   * Claude provider's authenticate() refuses to spawn a subprocess that
   * would silently bill the user's API account. Chainable — call once
   * before run().
   */
  allowApiKey(): this {
    this.#allowApiKey = true;
    return this;
  }

  async run<TInput>(
    flow: Flow<TInput>,
    input: unknown,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    const runId = shortRunId();
    const runDir = this.#runDirOverride ?? defaultRunDir(runId);
    const parallelism = opts.parallelism ?? DEFAULT_PARALLELISM;

    const parsed = flow.input.safeParse(input);
    if (!parsed.success) {
      throw toFlowDefError(parsed.error, `invalid input for flow "${flow.name}"`);
    }
    const validatedInput: TInput = parsed.data;

    await mkdir(runDir, { recursive: true });
    const liveDir = join(runDir, LIVE_STATE_DIRNAME);
    await rm(liveDir, { recursive: true, force: true });
    await mkdir(liveDir, { recursive: true });

    await this.#writeFlowRef(runDir, flow);

    const logger =
      this.#logger ??
      createLogger({
        flowName: flow.name,
        runId,
        logFile: join(runDir, RUN_LOG_FILENAME),
      });

    const handoffStore = new HandoffStore(runDir);
    const costTracker = new CostTracker(join(runDir, METRICS_FILENAME));
    const stateMachine = new StateMachine(runDir, flow.name, flow.version, runId);

    const initResult = await stateMachine.init(flow.graph.topoOrder);
    if (initResult.isErr()) throw initResult.error;

    stateMachine.getState().input = validatedInput;
    const initialSave = await stateMachine.save();
    if (initialSave.isErr()) throw initialSave.error;

    const abortController = new AbortController();
    const start = Date.now();

    let runStatus: 'succeeded' | 'failed';
    try {
      runStatus = await this.#walkDag({
        flow: flow as Flow<unknown>,
        runDir,
        runId,
        parallelism,
        abortController,
        handoffStore,
        costTracker,
        stateMachine,
        logger,
      });
    } finally {
      await this.#closeProviders(logger);
    }

    const markResult = stateMachine.markRun(runStatus);
    if (markResult.isErr()) throw markResult.error;
    const finalSave = await stateMachine.save();
    if (finalSave.isErr()) throw finalSave.error;

    const summary = costTracker.summary();
    const artifacts: string[] = [];
    for (const state of Object.values(stateMachine.getState().steps)) {
      if (state.artifacts !== undefined) artifacts.push(...state.artifacts);
    }

    return {
      runId,
      runDir,
      status: runStatus,
      cost: { totalUsd: summary.totalUsd, totalTokens: summary.totalTokens },
      artifacts,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Resume a run from its persisted state. Implementation lands in a later
   * task; the stub rejects so callers fail fast until the real protocol is
   * wired through.
   */
  async resume(_runDir: string): Promise<RunResult> {
    throw new PipelineError(
      'Runner.resume is not implemented yet',
      ERROR_CODES.STEP_FAILURE,
    );
  }

  async #writeFlowRef<TInput>(runDir: string, flow: Flow<TInput>): Promise<void> {
    // Flow objects carry no path back to their source module today, so
    // flowPath is persisted as null. A later task will plumb the origin
    // through defineFlow so resume can locate the flow without cwd guesses.
    const payload = {
      flowName: flow.name,
      flowVersion: flow.version,
      flowPath: null,
    };
    const result = await atomicWriteJson(join(runDir, FLOW_REF_FILENAME), payload);
    if (result.isErr()) throw result.error;
  }

  async #closeProviders(logger: Logger): Promise<void> {
    for (const provider of this.#providers.list()) {
      if (provider.close === undefined) continue;
      try {
        await provider.close();
      } catch (caught) {
        logger.warn(
          { event: 'provider.close_failed', provider: provider.name, error: errorMessageOf(caught) },
          'provider.close threw during cleanup',
        );
      }
    }
  }

  async #walkDag(args: {
    flow: Flow<unknown>;
    runDir: string;
    runId: string;
    parallelism: number;
    abortController: AbortController;
    handoffStore: HandoffStore;
    costTracker: CostTracker;
    stateMachine: StateMachine;
    logger: Logger;
  }): Promise<'succeeded' | 'failed'> {
    const {
      flow,
      runDir,
      runId,
      parallelism,
      abortController,
      handoffStore,
      costTracker,
      stateMachine,
      logger,
    } = args;

    const queue: string[] = [...flow.graph.rootSteps];
    const inflight = new Set<string>();
    const completions: Array<{ stepId: string; error?: unknown }> = [];
    let notify: (() => void) | null = null;
    let runFailed = false;

    const waitForCompletion = (): Promise<void> =>
      new Promise((resolve) => {
        notify = resolve;
      });

    const dispatch = (stepId: string): void => {
      const step = flow.steps[stepId];
      if (step === undefined) {
        completions.push({
          stepId,
          error: new FlowDefinitionError(`unknown step id "${stepId}"`),
        });
        return;
      }
      const startResult = stateMachine.startStep(stepId);
      if (startResult.isErr()) {
        completions.push({ stepId, error: startResult.error });
        return;
      }
      inflight.add(stepId);
      void stateMachine.save().then(() => {
        const attempt = stateMachine.getState().steps[stepId]?.attempts ?? 1;
        const ctx: StepExecutionContext = {
          flow,
          runDir,
          runId,
          flowName: flow.name,
          stepId,
          attempt,
          abortSignal: abortController.signal,
          handoffStore,
          costTracker,
          stateMachine,
          logger: logger.child({ stepId }),
          providers: this.#providers,
          defaultProvider: this.#defaultProvider,
          allowApiKey: this.#allowApiKey,
        };
        return executeStep(step, ctx);
      })
        .then(
          () => {
            completions.push({ stepId });
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
        if (queue.includes(candidate) || inflight.has(candidate)) continue;
        const preds = flow.graph.predecessors.get(candidate);
        if (preds === undefined) continue;
        let ready = true;
        for (const p of preds) {
          if (state[p]?.status !== 'succeeded') {
            ready = false;
            break;
          }
        }
        if (ready) queue.push(candidate);
      }
    };

    while (queue.length > 0 || inflight.size > 0) {
      while (!runFailed && queue.length > 0 && inflight.size < parallelism) {
        const next = queue.shift();
        if (next === undefined) break;
        dispatch(next);
      }

      if (inflight.size === 0 && completions.length === 0) break;

      if (completions.length === 0) {
        await waitForCompletion();
      }

      while (completions.length > 0) {
        const completed = completions.shift();
        if (completed === undefined) break;
        inflight.delete(completed.stepId);

        if (completed.error === undefined) {
          const result = stateMachine.completeStep(completed.stepId);
          if (result.isErr()) {
            logger.error(
              { event: 'state.transition_failed', stepId: completed.stepId, error: result.error.message },
              'state transition failed after step success',
            );
            runFailed = true;
          }
        } else {
          const message = errorMessageOf(completed.error);
          const result = stateMachine.failStep(completed.stepId, message);
          if (result.isErr()) {
            logger.error(
              { event: 'state.transition_failed', stepId: completed.stepId, error: result.error.message },
              'state transition failed after step failure',
            );
          }
          runFailed = true;
        }

        const saveResult = await stateMachine.save();
        if (saveResult.isErr()) {
          logger.error(
            { event: 'state.save_failed', error: saveResult.error.message },
            'state.json atomic write failed',
          );
        }
      }

      if (!runFailed) enqueueReady();
    }

    return runFailed ? 'failed' : 'succeeded';
  }
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  return new Runner(opts);
}
