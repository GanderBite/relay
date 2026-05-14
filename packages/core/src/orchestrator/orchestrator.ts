import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CostTracker } from '../cost.js';
import { ERROR_CODES, PipelineError, toFlowDefError } from '../errors.js';
import type { Flow, RunState, StepState } from '../flow/types.js';
import { HandoffStore } from '../handoffs.js';
import { createLogger, type Logger } from '../logger.js';
import { defaultRegistry, type ProviderRegistry } from '../providers/registry.js';
import { loadState, StateMachine, verifyCompatibility } from '../state.js';

import { executeRun } from './execute-run.js';
import { backCompatFlowDir, importFlow, loadFlowRef, seedReadyQueueForResume } from './resume.js';
import { writeFlowRef, writeHandoffHelper } from './run-bootstrap.js';
import type { OrchestratorOptions, RunOptions, RunResult } from './run-options.js';
// Side-effect import — populates `defaultStepRegistry` so the dispatcher
// resolves a registered entry for every step kind. Idempotent across reloads
// (the registrations file no-ops when the registry is already populated).
import './step-registrations.js';

export type {
  OrchestratorOptions,
  RunOptions,
  RunResult,
  StepExecutionContext,
} from './run-options.js';

const METRICS_FILENAME = 'metrics.json';
const RUN_LOG_FILENAME = 'run.log';

function shortRunId(): string {
  return randomBytes(3).toString('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultRunDir(runId: string): string {
  return join(process.cwd(), '.relay', 'runs', runId);
}

/**
 * Orchestrator drives the execution of a compiled Flow. Construct via
 * `createOrchestrator` (preferred) or `new Orchestrator(opts)`. A single
 * Orchestrator instance may serve multiple sequential `run()` calls;
 * concurrent calls share state and are not supported.
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
    const runDir = this.#runDirOverride ?? defaultRunDir(shortRunId());
    const runId = basename(runDir);
    const flowDir = opts.flowDir ?? process.cwd();

    const parsed = flow.input.safeParse(input);
    if (!parsed.success) {
      throw toFlowDefError(parsed.error, `invalid input for flow "${flow.name}"`);
    }
    const validatedInput: TInput = parsed.data;

    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'live'), { recursive: true });
    // Pre-create the per-run staging + helper-script directories so the
    // schema-bound prompt contract can reference them without having to
    // mkdir on every prompt invocation.
    await mkdir(join(runDir, '.tmp'), { recursive: true });
    await mkdir(join(runDir, '.bin'), { recursive: true });

    await writeFlowRef(runDir, flow, opts.flowPath, opts.flowDir);

    const logger = this.#buildLogger(flow.name, runId, runDir, opts);

    const handoffStore = new HandoffStore(runDir);
    const costTracker = new CostTracker(join(runDir, METRICS_FILENAME));
    const stateMachine = new StateMachine(runDir, flow.name, flow.version, runId);

    const initResult = await stateMachine.init(flow.graph.topoOrder);
    if (initResult.isErr()) throw initResult.error;

    stateMachine.getState().input = validatedInput;
    const initialSave = await stateMachine.save();
    if (initialSave.isErr()) throw initialSave.error;

    // Emit the per-run handoff helper script so schema-bound prompt steps can
    // round-trip validation inside a single Claude invocation. Failure to write
    // the script is fatal — without it, those prompts have no way to land a
    // valid handoff and the whole run will deadlock retrying.
    const helperResult = await writeHandoffHelper(runDir, flow);
    if (helperResult.isErr()) throw helperResult.error;

    return executeRun({
      flow: flow as Flow<unknown>,
      validatedInput,
      runDir,
      runId,
      flowDir,
      logger,
      handoffStore,
      costTracker,
      stateMachine,
      providers: this.#providers,
      opts,
      initialQueue: [...flow.graph.rootSteps],
    });
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
    const stateResult = await loadState(runDir);
    if (stateResult.isErr()) throw stateResult.error;
    const persistedState = stateResult.value;

    // A previously-succeeded run is idempotent — rebuild its RunResult from
    // the on-disk state + metrics.json and return without re-running any
    // steps. 'aborted', 'failed', 'running', and 'paused' all continue into
    // the normal resume walker, which resets failed/zombie steps to pending
    // and re-dispatches them.
    if (persistedState.status === 'succeeded') {
      return this.#rebuildSucceededResult(runDir, persistedState);
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
    // Resolution order: explicit opts.flowDir wins; then the flowDir the
    // original run() persisted into flow-ref.json; then a back-compat fallback
    // for legacy refs that recorded only flowPath. Never use dirname(flowPath)
    // directly — that returns the dist/ directory and breaks worktree probing.
    const flowDir = opts.flowDir ?? flowRef.flowDir ?? backCompatFlowDir(flowRef.flowPath);

    const logger = this.#buildLogger(flow.name, runId, runDir, opts);

    const handoffStore = new HandoffStore(runDir);
    const costTracker = new CostTracker(join(runDir, METRICS_FILENAME));
    const loadMetricsResult = await costTracker.load();
    if (loadMetricsResult.isErr()) throw loadMetricsResult.error;

    const stateMachine = new StateMachine(runDir, flow.name, flow.version, runId);
    stateMachine.hydrate(persistedState);

    // Resume gets a fresh helper script. `verifyCompatibility` already gates
    // on flow name + version, but rewriting the helper is cheap and
    // idempotent so we always do it.
    await mkdir(join(runDir, '.tmp'), { recursive: true });
    await mkdir(join(runDir, '.bin'), { recursive: true });
    const resumedHelperResult = await writeHandoffHelper(runDir, flow);
    if (resumedHelperResult.isErr()) throw resumedHelperResult.error;

    sweepZombieAndFailedSteps(stateMachine, persistedState);

    const markRunning = stateMachine.markRun('running');
    if (markRunning.isErr()) throw markRunning.error;
    const savedStart = await stateMachine.save();
    if (savedStart.isErr()) throw savedStart.error;

    const initialQueue = seedReadyQueueForResume(flow, stateMachine.getState());

    return executeRun({
      flow: flow as Flow<unknown>,
      validatedInput: stateMachine.getState().input,
      runDir,
      runId,
      flowDir,
      logger,
      handoffStore,
      costTracker,
      stateMachine,
      providers: this.#providers,
      opts,
      initialQueue,
    });
  }

  #buildLogger(flowName: string, runId: string, runDir: string, opts: RunOptions): Logger {
    return (
      this.#logger ??
      createLogger({
        flowName,
        runId,
        logFile: join(runDir, RUN_LOG_FILENAME),
        logToStdout: opts.logToStdout !== false,
      })
    );
  }

  /**
   * Rebuild a RunResult from a persisted, previously-succeeded run. Skips
   * provider authentication, the DAG walker, and every side effect of a fresh
   * resume — by contract a succeeded run is idempotent. Pulls cost totals
   * from metrics.json via CostTracker.load(), aggregates artifacts across
   * every succeeded step, and derives durationMs from the recorded
   * startedAt / updatedAt span so the returned shape matches a first-run
   * RunResult.
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
}

export function createOrchestrator(opts: OrchestratorOptions = {}): Orchestrator {
  return new Orchestrator(opts);
}

/**
 * Crash robustness: a SIGKILL (or OS crash) bypasses markRun(), so steps can
 * be persisted in 'running' status with no in-flight work to complete them.
 * Sweep them to 'failed' first so the subsequent failed -> pending pass picks
 * them up. Without this, those steps get filtered out of the ready queue and
 * the resumed run deadlocks.
 *
 * After the zombie sweep, flip failed steps back to pending so the retry loop
 * can take another attempt. resetStep preserves the attempts counter so
 * maxRetries budgets carry across resume. Paused ask steps follow the same
 * pattern via resumePausedStep, which additionally clears the run-level
 * awaitingInput pointer so the resumed snapshot reads as in-progress rather
 * than waiting on input that has already been supplied.
 *
 * Synthesised loop-body ask entries (keys containing `::`) are paused the
 * same way, but their pause carries a loopStepId/loopIter pointer on
 * awaitingInput that the enclosing loop step's executor reads via
 * getResumedIter to re-enter at the correct iteration. Clearing
 * awaitingInput here would force the loop to restart at iter 1; for those
 * entries we preserve awaitingInput, and completeStep clears it later when
 * the resumed body step consumes the supplied answer.
 */
function sweepZombieAndFailedSteps(stateMachine: StateMachine, persistedState: RunState): void {
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

  for (const [stepId, stepState] of Object.entries(stateMachine.getState().steps)) {
    if (stepState.status === 'failed') {
      const resetResult = stateMachine.resetStep(stepId);
      if (resetResult.isErr()) throw resetResult.error;
    } else if (stepState.status === 'paused') {
      const resumeResult = stateMachine.resumePausedStep(stepId, {
        preserveAwaitingInput: StateMachine.isBodyStepStateKey(stepId),
      });
      if (resumeResult.isErr()) throw resumeResult.error;
    }
  }
}
