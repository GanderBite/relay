import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
import type { Provider } from '../providers/types.js';
import { StateMachine } from '../state.js';
import { atomicWriteJson } from '../util/atomic-write.js';

import { checkCapabilities } from './capability-check.js';
import { executeBranch } from './exec/branch.js';
import { executeParallel } from './exec/parallel.js';
import { executePrompt } from './exec/prompt.js';
import { executeScript } from './exec/script.js';
import { executeTerminal } from './exec/terminal.js';
import { clearLiveDir } from './live-state.js';
import { withRetry } from './retry.js';
import type { StepResult } from './types.js';

const DEFAULT_PARALLELISM = 4;
const DEFAULT_PROVIDER_NAME = 'claude';
const FLOW_REF_FILENAME = 'flow-ref.json';
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
  /**
   * Directory the flow package lives in — used to resolve prompt template
   * paths (step.promptFile) relative to the flow. Defaults to process.cwd().
   * Set explicitly when the Runner is embedded in a host process whose cwd
   * is not the flow's directory.
   */
  flowDir?: string;
}

export interface RunResult {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed' | 'aborted';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
}

/**
 * Context threaded into every per-step executor. Executors receive a tailored
 * subset of this shape; the Runner builds each per-step ctx from this central
 * bag plus the resolved provider binding.
 */
export interface StepExecutionContext {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Internal marker for aborts surfaced through the runner's race. A dedicated
 * class keeps `instanceof` checks unambiguous without pulling DOMException
 * across the public surface.
 */
class RunAbortedError extends Error {
  constructor(message = 'run aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

function isAbortLike(err: unknown): boolean {
  if (err instanceof RunAbortedError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
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
    const flowDir = opts.flowDir ?? process.cwd();

    const parsed = flow.input.safeParse(input);
    if (!parsed.success) {
      throw toFlowDefError(parsed.error, `invalid input for flow "${flow.name}"`);
    }
    const validatedInput: TInput = parsed.data;

    await mkdir(runDir, { recursive: true });
    await clearLiveDir(runDir);
    await mkdir(join(runDir, 'live'), { recursive: true });

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

    const providerByStep = checkCapabilities(
      flow as Flow<unknown>,
      this.#providers,
      this.#defaultProvider,
    );
    const uniqueProviders = new Set<Provider>(providerByStep.values());

    const abortController = new AbortController();
    let abortSource: 'SIGINT' | 'SIGTERM' | null = null;
    const onSigint = (): void => {
      if (abortSource === null) abortSource = 'SIGINT';
      abortController.abort();
    };
    const onSigterm = (): void => {
      if (abortSource === null) abortSource = 'SIGTERM';
      abortController.abort();
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const start = Date.now();
    let runStatus: 'succeeded' | 'failed' | 'aborted' = 'failed';

    try {
      for (const provider of uniqueProviders) {
        const auth = await provider.authenticate();
        if (auth.isErr()) throw auth.error;
      }

      if (abortController.signal.aborted) {
        runStatus = 'aborted';
      } else {
        runStatus = await this.#walkDag({
          flow: flow as Flow<unknown>,
          runDir,
          runId,
          flowDir,
          parallelism,
          abortController,
          handoffStore,
          costTracker,
          stateMachine,
          logger,
          providerByStep,
          validatedInput,
        });
      }
    } finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      await this.#closeProviders(uniqueProviders, logger);
    }

    const markResult = stateMachine.markRun(runStatus);
    if (markResult.isErr()) throw markResult.error;
    const finalSave = await stateMachine.save();
    if (finalSave.isErr()) throw finalSave.error;

    if (runStatus === 'aborted') {
      logger.warn(
        { event: 'run.aborted', runId, source: abortSource ?? 'unknown' },
        'run aborted',
      );
    }

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
    // flowPath is persisted as null. A later task plumbs the origin through
    // defineFlow so resume can locate the flow without cwd guesses.
    const payload = {
      flowName: flow.name,
      flowVersion: flow.version,
      flowPath: null,
    };
    const result = await atomicWriteJson(join(runDir, FLOW_REF_FILENAME), payload);
    if (result.isErr()) throw result.error;
  }

  async #closeProviders(
    providers: Iterable<Provider>,
    logger: Logger,
  ): Promise<void> {
    for (const provider of providers) {
      if (provider.close === undefined) continue;
      try {
        await provider.close();
      } catch (caught) {
        logger.warn(
          {
            event: 'provider.close_failed',
            provider: provider.name,
            error: errorMessageOf(caught),
          },
          'provider.close threw during cleanup',
        );
      }
    }
  }

  async #walkDag(args: {
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
    validatedInput: unknown;
  }): Promise<'succeeded' | 'failed' | 'aborted'> {
    const {
      flow,
      runDir,
      runId,
      flowDir,
      parallelism,
      abortController,
      handoffStore,
      costTracker,
      stateMachine,
      logger,
      providerByStep,
      validatedInput,
    } = args;

    const inputVars = isPlainRecord(validatedInput) ? validatedInput : {};

    const queue: string[] = [...flow.graph.rootSteps];
    const inflight = new Set<string>();
    const completions: Array<{ stepId: string; error?: unknown }> = [];
    let notify: (() => void) | null = null;
    let runFailed = false;

    const waitForCompletion = (): Promise<void> =>
      new Promise((resolve) => {
        notify = resolve;
      });

    const onAbort = (): void => {
      const cb = notify;
      notify = null;
      if (cb !== null) cb();
    };
    if (abortController.signal.aborted) {
      // Already aborted before the loop started.
    } else {
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    const raceAbort = async <T>(work: Promise<T>): Promise<T> => {
      if (abortController.signal.aborted) {
        throw new RunAbortedError();
      }
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const handler = (): void => {
          reject(new RunAbortedError());
        };
        abortController.signal.addEventListener('abort', handler, { once: true });
      });
      return Promise.race([work, abortPromise]);
    };

    const runExecutor = async (step: Step, attempt: number): Promise<StepResult> => {
      const stepLogger = logger.child({ stepId: step.id });
      const baseCtx: StepExecutionContext = {
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
        providers: this.#providers,
        defaultProvider: this.#defaultProvider,
        allowApiKey: this.#allowApiKey,
      };

      switch (step.kind) {
        case 'prompt': {
          const provider = providerByStep.get(step.id);
          if (provider === undefined) {
            throw new FlowDefinitionError(
              `no provider resolved for prompt step "${step.id}"`,
              { stepId: step.id },
            );
          }
          return executePrompt(step, {
            runDir,
            flowDir,
            flowName: flow.name,
            runId,
            stepId: step.id,
            attempt,
            abortSignal: abortController.signal,
            handoffStore,
            costTracker,
            logger: stepLogger,
            provider,
            inputVars,
          });
        }
        case 'script':
          return executeScript(step, {
            runDir,
            stepId: step.id,
            attempt,
            abortSignal: abortController.signal,
            logger: stepLogger,
          });
        case 'branch':
          return executeBranch(step, {
            runDir,
            stepId: step.id,
            attempt,
            abortSignal: abortController.signal,
            logger: stepLogger,
          });
        case 'parallel':
          return executeParallel(step, {
            stepId: step.id,
            step,
            attempt,
            abortSignal: abortController.signal,
            logger: stepLogger,
            dispatch: async (branchStepId: string): Promise<unknown> => {
              const branchStep = flow.steps[branchStepId];
              if (branchStep === undefined) {
                throw new FlowDefinitionError(
                  `parallel step "${step.id}" branch references unknown step "${branchStepId}"`,
                );
              }
              return runExecutor(branchStep, attempt);
            },
          });
        case 'terminal':
          return executeTerminal(step, baseCtx);
      }
    };

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

      const maxRetries =
        step.kind === 'prompt' || step.kind === 'script' || step.kind === 'branch'
          ? step.maxRetries ?? 0
          : 0;
      const timeoutMs =
        step.kind === 'prompt' || step.kind === 'script' || step.kind === 'branch'
          ? step.timeoutMs
          : undefined;

      void stateMachine.save()
        .then(() =>
          raceAbort(
            withRetry((attempt) => runExecutor(step, attempt), {
              maxRetries,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              logger,
              stepId,
            }),
          ),
        )
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
          const predState = state[p];
          const predStatus = predState?.status;
          // `continue` onFail lets dependents run even after a failure.
          const pred = flow.steps[p];
          const predAllowsContinue =
            pred !== undefined &&
            pred.kind !== 'terminal' &&
            pred.kind !== 'parallel' &&
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
        if (ready) queue.push(candidate);
      }
    };

    const stepOnFail = (step: Step): 'abort' | 'continue' | string => {
      if (step.kind === 'terminal') return 'abort';
      if (step.kind === 'parallel') return step.onFail ?? 'abort';
      return step.onFail ?? 'abort';
    };

    while (queue.length > 0 || inflight.size > 0) {
      if (abortController.signal.aborted) break;

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
              {
                event: 'state.transition_failed',
                stepId: completed.stepId,
                error: result.error.message,
              },
              'state transition failed after step success',
            );
            runFailed = true;
          }
        } else if (isAbortLike(completed.error)) {
          // Abort leaves the step in running state; markRun('aborted') sweeps
          // it to failed with a descriptive errorMessage so on-disk state is
          // never stuck in running after SIGINT.
        } else {
          const message = errorMessageOf(completed.error);
          const result = stateMachine.failStep(completed.stepId, message);
          if (result.isErr()) {
            logger.error(
              {
                event: 'state.transition_failed',
                stepId: completed.stepId,
                error: result.error.message,
              },
              'state transition failed after step failure',
            );
          }
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
        }

        const saveResult = await stateMachine.save();
        if (saveResult.isErr()) {
          logger.error(
            { event: 'state.save_failed', error: saveResult.error.message },
            'state.json atomic write failed',
          );
        }
      }

      if (!runFailed && !abortController.signal.aborted) enqueueReady();
    }

    abortController.signal.removeEventListener('abort', onAbort);

    if (abortController.signal.aborted) return 'aborted';
    return runFailed ? 'failed' : 'succeeded';
  }
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  return new Runner(opts);
}
