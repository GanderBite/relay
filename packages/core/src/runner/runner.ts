import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CostTracker } from '../cost.js';
import {
  AuthTimeoutError,
  ERROR_CODES,
  FlowDefinitionError,
  PipelineError,
  StateWriteError,
  toFlowDefError,
} from '../errors.js';
import type { Flow, RunState, Step, StepState } from '../flow/types.js';
import { HandoffStore } from '../handoffs.js';
import { createLogger, type Logger } from '../logger.js';
import { defaultRegistry, ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { loadFlowSettings, loadGlobalSettings } from '../settings/load.js';
import { resolveProvider } from '../settings/resolve.js';
import { loadState, StateMachine, verifyCompatibility } from '../state.js';
import { atomicWriteJson } from '../util/atomic-write.js';

import { checkCapabilities } from './capability-check.js';
import { executeBranch } from './exec/branch.js';
import { executeParallel } from './exec/parallel.js';
import { executePrompt } from './exec/prompt.js';
import { executeScript } from './exec/script.js';
import { executeTerminal } from './exec/terminal.js';
import { clearLiveDir } from './live-state.js';
import { importFlow, loadFlowRef, seedReadyQueueForResume } from './resume.js';
import { withRetry } from './retry.js';
import type { StepResult } from './types.js';

const DEFAULT_PARALLELISM = 4;
// Mirrors the default in flow/schemas.ts. Duplicated here so the Runner
// can backstop hand-built PromptStepSpec values that bypassed the schema parse
// (e.g. spec literals authored without going through promptStep(...)).
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
// Wall-clock cap on a single provider.authenticate() call. A misconfigured
// auth probe (e.g. a hung `claude --version` subprocess) or a custom provider
// whose authenticate() never resolves would otherwise wedge the Runner before
// any step executes and bypass every step-level timeout. Configurable per-run
// via RunOptions.authTimeoutMs so integration tests can shorten it.
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const FLOW_REF_FILENAME = 'flow-ref.json';
const METRICS_FILENAME = 'metrics.json';
const RUN_LOG_FILENAME = 'run.log';

export interface RunnerOptions {
  providers?: ProviderRegistry;
  logger?: Logger;
  runDir?: string;
}

export interface RunOptions {
  resumeFrom?: string;
  parallelism?: number;
  /**
   * Directory the flow package lives in — used to resolve prompt template
   * paths (step.promptFile) relative to the flow AND to locate the per-flow
   * `settings.json` for provider resolution. Defaults to process.cwd().
   * Set explicitly when the Runner is embedded in a host process whose cwd
   * is not the flow's directory.
   */
  flowDir?: string;
  /**
   * Absolute path to the flow module that produced the supplied Flow. When
   * present, persisted in `flow-ref.json` so `Runner.resume(runDir)` can
   * re-import the flow in a fresh process. When absent, run() still proceeds
   * — resume later rejects with an actionable message if the caller omitted
   * the path and the run crashes.
   */
  flowPath?: string;
  /**
   * Wall-clock cap (milliseconds) on each provider.authenticate() call. When
   * the cap fires, the Runner raises `AuthTimeoutError` before any step runs.
   * Defaults to 30_000. Tests typically shorten this to keep the suite fast.
   */
  authTimeoutMs?: number;
  /**
   * Provider name supplied via the CLI `--provider` flag. When set it wins
   * over per-flow and per-user settings during resolution. Leave undefined to
   * fall back to the flow's `settings.json`, then `~/.relay/settings.json`,
   * and finally `NoProviderConfiguredError` if neither carries a name.
   */
  flagProvider?: string;
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
 *
 * Auth opt-in lives entirely in provider selection: selecting `claude-agent-sdk`
 * (via --provider, flow settings, or global settings) IS the API-key opt-in,
 * and that provider's authenticate() enforces the required ANTHROPIC_API_KEY.
 * No escape hatch is threaded through this context.
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
  provider: Provider;
}

function shortRunId(): string {
  return randomBytes(3).toString('hex');
}

function nowIso(): string {
  return new Date().toISOString();
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
  readonly #logger: Logger | undefined;
  readonly #runDirOverride: string | undefined;

  constructor(opts: RunnerOptions = {}) {
    this.#providers = opts.providers ?? defaultRegistry;
    this.#logger = opts.logger;
    this.#runDirOverride = opts.runDir;
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

    await this.#writeFlowRef(runDir, flow, opts.flowPath);

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

    // Provider resolution happens BEFORE any step runs, so a misconfiguration
    // surfaces as a single typed error (NoProviderConfiguredError or
    // FlowDefinitionError) rather than a half-executed run.
    const provider = await this.#resolveRunProvider(this.#providers, flowDir, opts.flagProvider);
    const providerByStep = checkCapabilities(flow as Flow<unknown>, provider);
    const uniqueProviders = new Set<Provider>([provider, ...providerByStep.values()]);

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
      await this.#authenticateAll(
        uniqueProviders,
        opts.authTimeoutMs,
        abortController.signal,
      );

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
          providers: this.#providers,
          provider,
          validatedInput,
          initialQueue: [...flow.graph.rootSteps],
        });
      }
    } catch (caught) {
      if (isAbortLike(caught)) {
        runStatus = 'aborted';
      } else {
        throw caught;
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
    stateMachine.clearStepResults();

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
   * Resume a run from its persisted state. Loads state.json + flow-ref.json
   * from `runDir`, re-imports the flow module, rehydrates the state machine
   * and cost tracker, and executes any remaining steps through the same DAG
   * walker as run(). Succeeded steps are never re-invoked; failed steps are
   * reset to pending so the retry loop can take another attempt (the prior
   * `attempts` counter survives so retry budgets are honored).
   */
  async resume(runDir: string, opts: RunOptions = {}): Promise<RunResult> {
    const parallelism = opts.parallelism ?? DEFAULT_PARALLELISM;

    const stateResult = await loadState(runDir);
    if (stateResult.isErr()) throw stateResult.error;
    const persistedState = stateResult.value;

    // Gate on the persisted run-level status before doing any work. A
    // previously-succeeded run is idempotent — rebuild its RunResult from the
    // on-disk state + metrics.json and return without re-running any steps.
    // 'aborted' (ctrl-c recorded by markRun) and 'failed' both continue into
    // the normal resume walker, which resets failed/zombie steps to pending
    // and re-dispatches them. 'running' means the prior process died before
    // markRun() landed; the zombie sweep below turns those into 'failed' so
    // the same reset pass picks them up.
    switch (persistedState.status) {
      case 'succeeded':
        return this.#rebuildSucceededResult(runDir, persistedState);
      case 'aborted':
      case 'failed':
      case 'running':
        // Fall through to the resume walker. Each case shares the same
        // recovery path (zombie sweep, failed -> pending, re-dispatch) so
        // surfacing them as distinct branches here is for documentation.
        break;
    }

    const flowRefResult = await loadFlowRef(runDir);
    if (flowRefResult.isErr()) {
      throw new PipelineError(
        `resume could not read flow-ref.json at "${runDir}": ${flowRefResult.error.message}. ` +
          'A resumable run records flow-ref.json at run start; without it the Runner cannot re-import the flow.',
        ERROR_CODES.STATE_NOT_FOUND,
        { runDir },
      );
    }
    const flowRef = flowRefResult.value;

    // Catch mismatches recorded in flow-ref.json vs. state.json before doing
    // any disk import — the state file is authoritative on what ran, so an
    // inconsistent flow-ref is also a resume-blocker.
    if (
      flowRef.flowName !== persistedState.flowName ||
      flowRef.flowVersion !== persistedState.flowVersion
    ) {
      throw new PipelineError(
        `flow-ref.json refers to "${flowRef.flowName}@${flowRef.flowVersion}" but state.json was written by "${persistedState.flowName}@${persistedState.flowVersion}". ` +
          'Start a fresh run.',
        ERROR_CODES.STATE_VERSION_MISMATCH,
        { runDir },
      );
    }

    if (flowRef.flowPath === null) {
      throw new PipelineError(
        'resume requires the original flow file path; pass `flowPath` to run() or re-invoke the CLI with the flow path.',
        ERROR_CODES.STATE_NOT_FOUND,
        { runDir, flowName: flowRef.flowName },
      );
    }

    const flow = await importFlow(flowRef.flowPath);

    const verify = verifyCompatibility(persistedState, {
      flowName: flow.name,
      flowVersion: flow.version,
    });
    if (verify.isErr()) throw verify.error;

    const runId = persistedState.runId;
    const flowDir = opts.flowDir ?? dirname(flowRef.flowPath);

    const logger =
      this.#logger ??
      createLogger({
        flowName: flow.name,
        runId,
        logFile: join(runDir, RUN_LOG_FILENAME),
      });

    const handoffStore = new HandoffStore(runDir);
    const costTracker = new CostTracker(join(runDir, METRICS_FILENAME));
    const loadMetricsResult = await costTracker.load();
    if (loadMetricsResult.isErr()) throw loadMetricsResult.error;

    const stateMachine = new StateMachine(runDir, flow.name, flow.version, runId);
    stateMachine.hydrate(persistedState);

    // Crash robustness: a SIGKILL (or OS crash) bypasses markRun(), so steps
    // can be persisted in 'running' status with no in-flight work to complete
    // them. Sweep them to 'failed' first so the subsequent failed -> pending
    // pass picks them up. Without this, those steps get filtered out of the
    // ready queue and the resumed run deadlocks.
    const zombieSweepIso = nowIso();
    const sweptSteps: Record<string, StepState> = { ...persistedState.steps };
    let hasZombie = false;
    for (const [stepId, stepState] of Object.entries(persistedState.steps)) {
      if (stepState.status === 'running') {
        sweptSteps[stepId] = {
          ...stepState,
          status: 'failed',
          completedAt: zombieSweepIso,
          errorMessage: 'run aborted by crash',
        };
        hasZombie = true;
      }
    }
    if (hasZombie) {
      stateMachine.hydrate({ ...persistedState, steps: sweptSteps });
    }

    // Flip failed steps back to pending so the retry loop can take another
    // attempt. resetStep preserves the attempts counter so maxRetries budgets
    // carry across resume.
    for (const [stepId, stepState] of Object.entries(stateMachine.getState().steps)) {
      if (stepState.status === 'failed') {
        const resetResult = stateMachine.resetStep(stepId);
        if (resetResult.isErr()) throw resetResult.error;
      }
    }

    const markRunning = stateMachine.markRun('running');
    if (markRunning.isErr()) throw markRunning.error;
    const savedStart = await stateMachine.save();
    if (savedStart.isErr()) throw savedStart.error;

    const provider = await this.#resolveRunProvider(this.#providers, flowDir, opts.flagProvider);
    const providerByStep = checkCapabilities(flow as Flow<unknown>, provider);
    const uniqueProviders = new Set<Provider>([provider, ...providerByStep.values()]);

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
      await this.#authenticateAll(
        uniqueProviders,
        opts.authTimeoutMs,
        abortController.signal,
      );

      if (abortController.signal.aborted) {
        runStatus = 'aborted';
      } else {
        const initialQueue = seedReadyQueueForResume(flow, stateMachine.getState());
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
          providers: this.#providers,
          provider,
          validatedInput: stateMachine.getState().input,
          initialQueue,
        });
      }
    } catch (caught) {
      if (isAbortLike(caught)) {
        runStatus = 'aborted';
      } else {
        throw caught;
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
    stateMachine.clearStepResults();

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
   * Rebuild a RunResult from a persisted, previously-succeeded run. Skips
   * provider authentication, the DAG walker, and every side effect of a fresh
   * resume — by contract a succeeded run is idempotent. Pulls cost totals
   * from metrics.json via CostTracker.load() (the state.json snapshot does
   * not carry per-step token counts), aggregates artifacts across every
   * succeeded step, and derives durationMs from the recorded startedAt /
   * updatedAt span so the returned shape matches a first-run RunResult.
   */
  async #rebuildSucceededResult(
    runDir: string,
    persistedState: RunState,
  ): Promise<RunResult> {
    const costTracker = new CostTracker(join(runDir, METRICS_FILENAME));
    const loadResult = await costTracker.load();
    if (loadResult.isErr()) throw loadResult.error;
    const summary = costTracker.summary();

    const artifacts: string[] = [];
    for (const state of Object.values(persistedState.steps)) {
      if (state.artifacts !== undefined) artifacts.push(...state.artifacts);
    }

    const start = Date.parse(persistedState.startedAt);
    const end = Date.parse(persistedState.updatedAt);
    const durationMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;

    return {
      runId: persistedState.runId,
      runDir,
      status: 'succeeded',
      cost: { totalUsd: summary.totalUsd, totalTokens: summary.totalTokens },
      artifacts,
      durationMs,
    };
  }

  /**
   * Run the per-run provider resolution chain — flag → flow settings → global
   * settings → registry. Surfaces typed errors verbatim so the CLI exit-code
   * mapper can branch on `NoProviderConfiguredError` (E_NO_PROVIDER) and on a
   * `FlowDefinitionError` for an unknown provider name. Settings file IO
   * errors are also bubbled — a malformed settings.json must not silently
   * collapse to a different provider.
   */
  async #resolveRunProvider(
    registry: ProviderRegistry,
    flowDir: string,
    flagProvider: string | undefined,
  ): Promise<Provider> {
    const globalResult = await loadGlobalSettings();
    if (globalResult.isErr()) throw globalResult.error;
    const flowResult = await loadFlowSettings(flowDir);
    if (flowResult.isErr()) throw flowResult.error;

    const args: Parameters<typeof resolveProvider>[0] = {
      flowSettings: flowResult.value,
      globalSettings: globalResult.value,
      registry,
    };
    if (flagProvider !== undefined) {
      args.flagProvider = flagProvider;
    }

    const resolved = resolveProvider(args);
    if (resolved.isErr()) throw resolved.error;
    return resolved.value;
  }

  async #writeFlowRef<TInput>(
    runDir: string,
    flow: Flow<TInput>,
    flowPath: string | undefined,
  ): Promise<void> {
    const payload = {
      flowName: flow.name,
      flowVersion: flow.version,
      flowPath: flowPath ?? null,
    };
    const result = await atomicWriteJson(join(runDir, FLOW_REF_FILENAME), payload);
    if (result.isErr()) throw result.error;
  }

  /**
   * Authenticate each unique provider with a wall-clock cap. Throws the first
   * provider's err-branch error, an `AuthTimeoutError`, or a `RunAbortedError`
   * — whichever resolves first. The setTimeout handle is cleared and the
   * abort listener is removed on the happy path so a fast auth does not keep
   * the event loop alive past run completion and the run's AbortController
   * does not accumulate stale listeners across retries.
   */
  async #authenticateAll(
    providers: Iterable<Provider>,
    authTimeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const timeoutMs = authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    for (const provider of providers) {
      if (signal.aborted) throw new RunAbortedError();

      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          reject(
            new AuthTimeoutError(
              `provider "${provider.name}" authenticate() did not settle within ${timeoutMs}ms`,
              provider.name,
              timeoutMs,
            ),
          );
        }, timeoutMs);
      });

      let abortHandler: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortHandler = (): void => {
          reject(new RunAbortedError());
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      });

      try {
        const auth = await Promise.race([
          provider.authenticate(),
          timeoutPromise,
          abortPromise,
        ]);
        if (auth.isErr()) throw auth.error;
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
        if (abortHandler !== undefined) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
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
    providers: ProviderRegistry;
    provider: Provider;
    validatedInput: unknown;
    initialQueue: string[];
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
      providers,
      provider,
      validatedInput,
      initialQueue,
    } = args;

    const inputVars = isPlainRecord(validatedInput) ? validatedInput : {};

    const queue: string[] = [...initialQueue];
    const queued = new Set<string>(initialQueue);
    const inflight = new Set<string>();
    const completions: Array<{
      stepId: string;
      error?: unknown;
      result?: StepResult;
    }> = [];
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

    // Everything past the registration runs inside a try/finally so the abort
    // listener is removed even when the walker throws before reaching a normal
    // return (e.g. a state.json save failure). Without this guard, listeners
    // leak onto the shared AbortController and node eventually warns with
    // MaxListenersExceededWarning on long or frequently-failing runs.
    try {
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
        providers,
        provider,
      };

      switch (step.kind) {
        case 'prompt': {
          const stepProvider = providerByStep.get(step.id);
          if (stepProvider === undefined) {
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
            provider: stepProvider,
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
            // Branches share the same dispatch path as top-level steps so each
            // branch honors its own maxRetries/timeoutMs/abort policy. Without
            // this, a branch with maxRetries: 3 dispatched via parallel would
            // fail on the first attempt regardless of its own retry budget.
            dispatch: (branchStepId: string): Promise<StepResult> =>
              dispatchStep(branchStepId),
            // On retry (the Runner re-dispatched the parent parallel step
            // after a mixed-outcome first attempt) or on a resumed run, some
            // branches may already be in 'succeeded' status. Re-dispatching
            // those trips startStep's pending-only guard with a confusing
            // StateTransitionError. Expose both the current branch status and
            // any cached result so the parallel executor can short-circuit.
            getBranchStatus: (branchStepId: string) => {
              const branchState = stateMachine.getState().steps[branchStepId];
              return branchState?.status ?? 'unknown';
            },
            getBranchResult: (branchStepId: string) =>
              stateMachine.getStepResult(branchStepId),
          });
        case 'terminal':
          return executeTerminal(step, baseCtx);
      }
    };

    const stepRetryBudget = (
      step: Step,
    ): { maxRetries: number; timeoutMs: number | undefined } => {
      if (step.kind === 'prompt') {
        // Backstop for the §4.4.1 default. The schema applies the same value
        // when authors run their flow through promptStep(...), but the Runner
        // also accepts hand-built PromptStepSpec literals; without this fallback
        // a runaway invocation could stream tokens indefinitely.
        return {
          maxRetries: step.maxRetries ?? 0,
          timeoutMs: step.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
        };
      }
      if (step.kind === 'script' || step.kind === 'branch') {
        return { maxRetries: step.maxRetries ?? 0, timeoutMs: step.timeoutMs };
      }
      return { maxRetries: 0, timeoutMs: undefined };
    };

    const promptStepOutput = (
      result: StepResult,
    ): { handoffs?: readonly string[]; artifacts?: readonly string[] } => {
      if (
        typeof result !== 'object' ||
        result === null ||
        !('kind' in result) ||
        result.kind !== 'prompt'
      ) {
        return {};
      }
      // PromptStepResult tracks handoffs (keys produced via output.handoff)
      // and artifacts (file paths produced via output.artifact) as independent
      // arrays. completeStep persists both projections on StepState verbatim
      // so RunResult.artifacts surfaces every file the step produced and
      // resume can introspect which handoffs landed without re-reading them.
      return { handoffs: result.handoffs, artifacts: result.artifacts };
    };

    /**
     * Run one step end-to-end: state transitions, retry, abort race, and
     * either completeStep (with the executor's result) or failStep on error.
     * Returns the executor's StepResult so callers like the parallel executor
     * can use the value; throws on failure (including abort) so awaiters get
     * the same error class withRetry+raceAbort produce.
     *
     * The DAG walker calls this and pushes the outcome into the completions
     * queue; the parallel executor's branch dispatch awaits it directly.
     * Either path performs the same state mutations exactly once per step.
     */
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
        const startResult = stateMachine.startStep(stepId);
        if (startResult.isErr()) throw startResult.error;

        const { maxRetries, timeoutMs } = stepRetryBudget(step);

        const startSave = await stateMachine.save();
        if (startSave.isErr()) {
          logger.error(
            { event: 'state.save_failed', error: startSave.error.message },
            'state.json atomic write failed',
          );
          throw startSave.error;
        }

        try {
          const value = await raceAbort(
            withRetry((attempt) => runExecutor(step, attempt), {
              maxRetries,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              logger,
              stepId,
            }),
          );
          const completeResult = stateMachine.completeStep(stepId, promptStepOutput(value));
          if (completeResult.isErr()) throw completeResult.error;
          stateMachine.recordStepResult(stepId, value);
          return value;
        } catch (caught) {
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

    const enqueueWalker = (stepId: string): void => {
      void dispatchStep(stepId)
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
        if (queued.has(candidate) || inflight.has(candidate)) continue;
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
        if (ready) { queue.push(candidate); queued.add(candidate); }
      }
    };

    const stepOnFail = (step: Step): 'abort' | 'continue' | string => {
      if (step.kind === 'terminal') return 'abort';
      return step.onFail ?? 'abort';
    };

    while (queue.length > 0 || inflight.size > 0) {
      if (abortController.signal.aborted) break;

      while (!runFailed && queue.length > 0 && inflight.size < parallelism) {
        const next = queue.shift();
        if (next === undefined) break;
        queued.delete(next);
        enqueueWalker(next);
      }

      if (inflight.size === 0 && completions.length === 0) break;

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

    if (abortController.signal.aborted) return 'aborted';
    return runFailed ? 'failed' : 'succeeded';
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
    }
  }
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  return new Runner(opts);
}
