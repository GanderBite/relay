import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
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
import { defaultRegistry, type ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { loadFlowSettings, loadGlobalSettings } from '../settings/load.js';
import { resolveProvider } from '../settings/resolve.js';
import { loadState, StateMachine, verifyCompatibility } from '../state.js';
import { atomicWriteJson } from '../util/atomic-write.js';
import { createWorktree, isGitRepo, removeWorktree } from '../util/worktree.js';

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
// Mirrors the default in flow/schemas.ts. Duplicated here so the Orchestrator
// can backstop hand-built PromptStepSpec values that bypassed the schema parse
// (e.g. spec literals authored without going through promptStep(...)).
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
// Wall-clock cap on a single provider.authenticate() call. A misconfigured
// auth probe (e.g. a hung `claude --version` subprocess) or a custom provider
// whose authenticate() never resolves would otherwise wedge the Orchestrator before
// any step executes and bypass every step-level timeout. Configurable per-run
// via RunOptions.authTimeoutMs so integration tests can shorten it.
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const FLOW_REF_FILENAME = 'flow-ref.json';
const METRICS_FILENAME = 'metrics.json';
const RUN_LOG_FILENAME = 'run.log';

export interface OrchestratorOptions {
  providers?: ProviderRegistry;
  logger?: Logger;
  runDir?: string;
}

/**
 * Options passed to `Orchestrator.run()` and `Orchestrator.resume()`.
 *
 * @remarks RunOptions is defined here rather than in a separate step/types.ts
 * — it intentionally co-locates with the Orchestrator class that consumes it.
 */
export interface RunOptions {
  resumeFrom?: string;
  parallelism?: number;
  /**
   * Directory the flow package lives in — used to resolve prompt template
   * paths (step.promptFile) relative to the flow AND to locate the per-flow
   * `settings.json` for provider resolution. Defaults to process.cwd().
   * Set explicitly when the Orchestrator is embedded in a host process whose cwd
   * is not the flow's directory.
   */
  flowDir?: string;
  /**
   * Absolute path to the flow module that produced the supplied Flow. When
   * present, persisted in `flow-ref.json` so `Orchestrator.resume(runDir)` can
   * re-import the flow in a fresh process. When absent, run() still proceeds
   * — resume later rejects with an actionable message if the caller omitted
   * the path and the run crashes.
   */
  flowPath?: string;
  /**
   * Wall-clock cap (milliseconds) on each provider.authenticate() call. When
   * the cap fires, the Orchestrator raises `AuthTimeoutError` before any step runs.
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
  /**
   * Isolate this run in a per-run git worktree rooted at $TMPDIR. Prompt
   * subprocesses are spawned with the worktree path as their cwd so every
   * file edit lands in an isolated checkout that is torn down when the run
   * finishes.
   *
   * - `'auto'` (default): create a worktree when the flowDir is inside a git
   *   repo; silently proceed without one when git is unavailable or the
   *   directory is not a working tree.
   * - `true`: require a worktree. If git is missing or the flowDir is not in
   *   a repo, the run fails before any step executes.
   * - `false`: disable the feature. Subprocesses inherit the parent cwd.
   *
   * When the flow has no prompt steps the worktree is created and
   * immediately torn down; use `worktree: false` for script-only flows.
   */
  worktree?: boolean | 'auto';
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
 * subset of this shape; the Orchestrator builds each per-step ctx from this central
 * bag plus the resolved provider binding.
 *
 * Auth is enforced at provider selection: the configured provider's authenticate()
 * runs before the flow starts. No auth escape hatch is threaded through this context.
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
  /**
   * Working directory the provider subprocess should run in — the per-run
   * git worktree when isolation is active, otherwise undefined so the
   * subprocess inherits the parent process cwd.
   */
  cwd?: string;
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
 * Internal marker for aborts surfaced through the step's flow. A dedicated
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
 * Orchestrator drives the execution of a compiled Flow. Construct via
 * `createOrchestrator` (preferred) or `new Orchestrator(opts)`. A single Orchestrator instance
 * may serve multiple sequential `run()` calls; concurrent calls share state
 * and are not supported.
 */
export class Orchestrator {
  readonly #providers: ProviderRegistry;
  readonly #logger: Logger | undefined;
  readonly #runDirOverride: string | undefined;

  constructor(opts: OrchestratorOptions = {}) {
    this.#providers = opts.providers ?? defaultRegistry;
    this.#logger = opts.logger;
    this.#runDirOverride = opts.runDir;
  }

  async run<TInput>(flow: Flow<TInput>, input: unknown, opts: RunOptions = {}): Promise<RunResult> {
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
    // Declared outside the try so the finally block can tear down whatever
    // setupWorktree produced, including a partial success where create-after-
    // probe throws mid-way.
    let worktreePath: string | undefined;
    let gitRoot: string | undefined;

    try {
      await this.#authenticateAll(uniqueProviders, opts.authTimeoutMs, abortController.signal);

      // Worktree setup happens AFTER auth so an auth timeout (or missing
      // provider) does not spend seconds on a `git worktree add` that would
      // immediately be torn down. `worktree: true` still fails fast here —
      // before the DAG walker dispatches any step.
      const worktree = await this.#setupWorktree(
        flowDir,
        runId,
        opts,
        logger,
        abortController.signal,
      );
      worktreePath = worktree.worktreePath;
      gitRoot = worktree.gitRoot;

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
          invocationCwd: worktree.worktreeCwd,
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
      await this.#teardownWorktree(worktreePath, gitRoot, logger);
    }

    const markResult = stateMachine.markRun(runStatus);
    if (markResult.isErr()) throw markResult.error;
    const finalSave = await stateMachine.save();
    if (finalSave.isErr()) throw finalSave.error;
    stateMachine.clearStepResults();

    if (runStatus === 'aborted') {
      logger.warn({ event: 'run.aborted', runId, source: abortSource ?? 'unknown' }, 'run aborted');
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
          'A resumable run records flow-ref.json at run start; without it the Orchestrator cannot re-import the flow.',
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
    // A resumed run gets its own fresh worktree. Declared outside the try so
    // the finally block can tear down a partial setup even when auth or the
    // worktree creation itself throws.
    let worktreePath: string | undefined;
    let gitRoot: string | undefined;

    try {
      await this.#authenticateAll(uniqueProviders, opts.authTimeoutMs, abortController.signal);

      // Worktree setup happens AFTER auth so an auth timeout does not spend
      // seconds on a `git worktree add` that would immediately be torn down.
      // The previous run's worktree (if any) was removed in its own finally
      // block; if that cleanup was skipped by a SIGKILL, the worktree lives
      // under $TMPDIR/relay-worktrees where the OS reclaims it.
      const worktree = await this.#setupWorktree(
        flowDir,
        runId,
        opts,
        logger,
        abortController.signal,
      );
      worktreePath = worktree.worktreePath;
      gitRoot = worktree.gitRoot;

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
          invocationCwd: worktree.worktreeCwd,
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
      await this.#teardownWorktree(worktreePath, gitRoot, logger);
    }

    const markResult = stateMachine.markRun(runStatus);
    if (markResult.isErr()) throw markResult.error;
    const finalSave = await stateMachine.save();
    if (finalSave.isErr()) throw finalSave.error;
    stateMachine.clearStepResults();

    if (runStatus === 'aborted') {
      logger.warn({ event: 'run.aborted', runId, source: abortSource ?? 'unknown' }, 'run aborted');
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
  async #rebuildSucceededResult(runDir: string, persistedState: RunState): Promise<RunResult> {
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
   * Bring up a per-run git worktree so the provider subprocess operates on an
   * isolated checkout. The return value carries the worktree path, the
   * enclosing git root, and the worktree-equivalent of `flowDir` — the
   * subprocess cwd the walker passes to each executor. When isolation is
   * disabled or silently skipped (auto mode outside a git repo), all three
   * fields are undefined and the subprocess inherits the parent cwd.
   *
   * `worktree: true` is an explicit opt-in to isolation; any probe or create
   * failure is surfaced so the run aborts before any tokens are spent.
   * `worktree: 'auto'` (the default) treats the feature as best-effort and
   * logs a debug breadcrumb when the repo is unavailable.
   */
  async #setupWorktree(
    flowDir: string,
    runId: string,
    opts: RunOptions,
    logger: Logger,
    signal: AbortSignal,
  ): Promise<{
    worktreePath: string | undefined;
    gitRoot: string | undefined;
    worktreeCwd: string | undefined;
  }> {
    const setting = opts.worktree ?? 'auto';
    if (setting === false) {
      return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
    }
    const required = setting === true;

    // Short-circuit when abort has already fired so we neither spawn git nor
    // pay the rev-parse probe's wall clock. The caller's post-setup check
    // notices the aborted signal and skips the DAG walker.
    if (signal.aborted) {
      return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
    }

    const probeDir = isAbsolute(flowDir) ? flowDir : join(process.cwd(), flowDir);
    const gitResult = await isGitRepo(probeDir, signal);
    if (gitResult.isErr()) {
      if (required) throw gitResult.error;
      logger.debug(
        { event: 'worktree.skip_no_repo', flowDir: probeDir },
        'not a git repo; proceeding without worktree isolation',
      );
      return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
    }

    const gitRoot = gitResult.value;

    // Abort may have fired while the probe was in flight. Skip the create to
    // avoid a stray worktree the caller would immediately have to tear down.
    if (signal.aborted) {
      return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
    }

    const createResult = await createWorktree({ gitRoot, runId, logger, signal });
    if (createResult.isErr()) {
      if (required) throw createResult.error;
      logger.debug(
        { event: 'worktree.skip_create_failed', gitRoot, error: createResult.error.message },
        'worktree creation failed; proceeding without isolation',
      );
      return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
    }

    const worktreePath = createResult.value;

    // Map the original flowDir onto its equivalent path inside the worktree so
    // the subprocess runs at the same relative location it would in the real
    // checkout. When flowDir is outside gitRoot (e.g. a flow installed in
    // node_modules that sits alongside the repo rather than inside it) the
    // relative path starts with '..'; joining that onto worktreePath would
    // escape the isolated checkout entirely, so we fall back to the worktree
    // root. The flow package is still read from its original flowDir — only
    // the subprocess cwd is rebased.
    const rel = relative(gitRoot, probeDir);
    const worktreeCwd =
      rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        ? join(worktreePath, rel)
        : worktreePath;

    return { worktreePath, gitRoot, worktreeCwd };
  }

  /**
   * Remove the per-run worktree. Called from the run's finally block, so any
   * failure is logged at warn and swallowed — letting a cleanup error escape
   * would mask the real failure that triggered the finally. Cleanup is bounded
   * by the 30 s GIT_WORKTREE_REMOVE_TIMEOUT_MS inside worktree.ts; on timeout
   * the error is logged at warn and the run completes normally.
   */
  async #teardownWorktree(
    worktreePath: string | undefined,
    gitRoot: string | undefined,
    logger: Logger,
  ): Promise<void> {
    if (worktreePath === undefined || gitRoot === undefined) return;
    const result = await removeWorktree({ gitRoot, worktreePath, logger });
    if (result.isErr()) {
      logger.warn(
        {
          event: 'worktree.cleanup_failed',
          worktreePath,
          gitRoot,
          error: result.error.message,
        },
        'worktree cleanup failed',
      );
    }
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
        const auth = await Promise.race([provider.authenticate(), timeoutPromise, abortPromise]);
        if (auth.isErr()) throw auth.error;
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
        if (abortHandler !== undefined) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
  }

  async #closeProviders(providers: Iterable<Provider>, logger: Logger): Promise<void> {
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
    /**
     * Working directory handed to every provider invocation for this run —
     * typically the per-run worktree path (or its flowDir-equivalent subpath)
     * when isolation is active. Undefined when worktree isolation is disabled
     * or auto-skipped, so the subprocess inherits the parent cwd.
     */
    invocationCwd: string | undefined;
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
      invocationCwd,
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
          ...(invocationCwd !== undefined ? { cwd: invocationCwd } : {}),
        };

        switch (step.kind) {
          case 'prompt': {
            const stepProvider = providerByStep.get(step.id);
            if (stepProvider === undefined) {
              throw new FlowDefinitionError(`no provider resolved for prompt step "${step.id}"`, {
                stepId: step.id,
              });
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
              ...(invocationCwd !== undefined ? { cwd: invocationCwd } : {}),
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
              dispatch: (branchStepId: string): Promise<StepResult> => dispatchStep(branchStepId),
              // On retry (the Orchestrator re-dispatched the parent parallel step
              // after a mixed-outcome first attempt) or on a resumed run, some
              // branches may already be in 'succeeded' status. Re-dispatching
              // those trips startStep's pending-only guard with a confusing
              // StateTransitionError. Expose both the current branch status and
              // any cached result so the parallel executor can short-circuit.
              getBranchStatus: (branchStepId: string) => {
                const branchState = stateMachine.getState().steps[branchStepId];
                return branchState?.status ?? 'unknown';
              },
              getBranchResult: (branchStepId: string) => stateMachine.getStepResult(branchStepId),
            });
          case 'terminal':
            return executeTerminal(step, baseCtx);
        }
      };

      const stepRetryBudget = (
        step: Step,
      ): { maxRetries: number; timeoutMs: number | undefined } => {
        if (step.kind === 'prompt') {
          // Backstop for the default prompt timeout. The schema applies the same value
          // when authors run their flow through step.prompt(...), but the Orchestrator
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
       * Run one step end-to-end: state transitions, retry, abort flow, and
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
          if (ready) {
            queue.push(candidate);
            queued.add(candidate);
          }
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

export function createOrchestrator(opts: OrchestratorOptions = {}): Orchestrator {
  return new Orchestrator(opts);
}
