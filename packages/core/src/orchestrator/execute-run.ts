import type { CostTracker } from '../cost.js';
import type { AbortReason } from '../errors.js';
import type { Flow } from '../flow/types.js';
import type { HandoffStore } from '../handoffs.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AuthState, Provider } from '../providers/types.js';
import type { StateMachine } from '../state.js';

import { authenticateProviders, resolveAndAuthenticate } from './auth.js';
import { checkCapabilities } from './capability-check.js';
import { walkDag } from './dag-walk.js';
import { closeProviders } from './run-bootstrap.js';
import { isAbortLike } from './run-internal.js';
import type { RunOptions, RunResult } from './run-options.js';
import { setupWorktree, teardownWorktree } from './worktree-setup.js';

const DEFAULT_PARALLELISM = 4;

export interface ExecuteRunInputs {
  flow: Flow<unknown>;
  validatedInput: unknown;
  runDir: string;
  runId: string;
  flowDir: string;
  logger: Logger;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  stateMachine: StateMachine;
  providers: ProviderRegistry;
  opts: RunOptions;
  initialQueue: string[];
}

/**
 * Single shared execution path for run() and resume(). Owns auth bootstrap,
 * worktree setup, SIGINT/SIGTERM wiring, the DAG walker invocation, provider
 * teardown, and the final RunResult assembly. Both entry points hand in the
 * collaborators they have already prepared (state machine, logger, etc.) and
 * a precomputed `initialQueue`.
 *
 * Installs process-level SIGINT/SIGTERM listeners for the duration of one
 * invocation and removes them in the finally block. Concurrent calls are not
 * supported — overlapping invocations would each install their own listeners
 * and both abort on a single signal. Embedded hosts that may invoke this in
 * parallel must serialize calls externally.
 */
export async function executeRun(inputs: ExecuteRunInputs): Promise<RunResult> {
  const {
    flow,
    validatedInput,
    runDir,
    runId,
    flowDir,
    logger,
    handoffStore,
    costTracker,
    stateMachine,
    providers,
    opts,
  } = inputs;
  const parallelism = opts.parallelism ?? DEFAULT_PARALLELISM;

  const abortController = new AbortController();
  let abortSource: AbortReason | null = null;
  const onSigint = (): void => {
    if (abortSource === null) abortSource = { kind: 'signal', signal: 'SIGINT' };
    abortController.abort();
  };
  const onSigterm = (): void => {
    if (abortSource === null) abortSource = { kind: 'signal', signal: 'SIGTERM' };
    abortController.abort();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const start = Date.now();
  let runStatus: 'succeeded' | 'failed' | 'aborted' | 'paused' = 'failed';
  let firstError: Error | undefined;
  let pausedStepId: string | undefined;
  let worktreePath: string | undefined;
  let gitRoot: string | undefined;
  let uniqueProviders: Set<Provider> = new Set();

  try {
    // Provider resolution + authentication happens BEFORE any step runs, so
    // a misconfiguration surfaces as a single typed error
    // (NoProviderConfiguredError, FlowDefinitionError, AuthTimeoutError, or
    // a provider's authenticate() error) rather than a half-executed run.
    const { provider } = await resolveAndAuthenticate({
      flagProvider: opts.flagProvider,
      flowDir,
      registry: providers,
      ...(opts.authTimeoutMs !== undefined ? { authTimeoutMs: opts.authTimeoutMs } : {}),
      signal: abortController.signal,
      ...(opts.preAuthedState !== undefined ? { preAuthedState: opts.preAuthedState } : {}),
    });
    const providerByStep = checkCapabilities(flow, provider);
    uniqueProviders = new Set<Provider>([provider, ...providerByStep.values()]);

    // Per-step provider overrides surfaced by checkCapabilities still need
    // their own authenticate() call. The default was just authenticated
    // above, so seed preAuthedState with the default's name to skip it on
    // the iterating call without duplicating its probe.
    const skipDefaultAuth = new Map(opts.preAuthedState ?? []);
    skipDefaultAuth.set(provider.name, skipDefaultAuth.get(provider.name) ?? ({} as AuthState));
    await authenticateProviders(uniqueProviders, {
      ...(opts.authTimeoutMs !== undefined ? { authTimeoutMs: opts.authTimeoutMs } : {}),
      signal: abortController.signal,
      preAuthedState: skipDefaultAuth,
    });

    // Worktree setup happens AFTER auth so an auth timeout (or missing
    // provider) does not spend seconds on a `git worktree add` that would
    // immediately be torn down. `worktree: true` still fails fast here —
    // before the DAG walker dispatches any step.
    const worktree = await setupWorktree({
      flowDir,
      runId,
      setting: opts.worktree,
      logger,
      signal: abortController.signal,
    });
    worktreePath = worktree.worktreePath;
    gitRoot = worktree.gitRoot;

    if (abortController.signal.aborted) {
      runStatus = 'aborted';
    } else {
      const walkResult = await walkDag({
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
        initialQueue: inputs.initialQueue,
        invocationCwd: worktree.worktreeCwd,
        recordAbortSource: (reason) => {
          if (abortSource === null) abortSource = reason;
        },
        ...(opts.onStepComplete !== undefined ? { onStepComplete: opts.onStepComplete } : {}),
        ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
      });
      runStatus = walkResult.status;
      firstError = walkResult.firstError;
      pausedStepId = walkResult.pausedStepId;
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
    await closeProviders(uniqueProviders, logger);
    await teardownWorktree(worktreePath, gitRoot, logger);
  }

  // Paused runs already had their run-level status flipped to 'paused' by
  // pauseStep inside the walker; re-applying markRun here would either be
  // a no-op or, worse, sweep the in-flight ask step into 'failed'. Skip
  // the markRun pass and persist whatever the pause path already wrote.
  if (runStatus !== 'paused') {
    const markResult = stateMachine.markRun(runStatus);
    if (markResult.isErr()) throw markResult.error;
  }
  const finalSave = await stateMachine.save();
  if (finalSave.isErr()) throw finalSave.error;
  stateMachine.clearStepResults();

  if (runStatus === 'aborted') {
    logger.warn(
      { event: 'run.aborted', runId, source: abortSource ?? { kind: 'unknown' } },
      'run aborted',
    );
  }

  const summary = costTracker.summary();
  const artifacts: string[] = [];
  for (const state of Object.values(stateMachine.getState().steps)) {
    if (state.artifacts !== undefined) artifacts.push(...state.artifacts);
  }

  const abortReason: AbortReason | undefined =
    runStatus === 'aborted' ? (abortSource ?? { kind: 'unknown' }) : undefined;
  return {
    runId,
    runDir,
    status: runStatus,
    cost: { totalUsd: summary.totalUsd, totalTokens: summary.totalTokens },
    artifacts,
    durationMs: Date.now() - start,
    ...(firstError !== undefined ? { firstError } : {}),
    ...(pausedStepId !== undefined ? { pausedStepId } : {}),
    ...(abortReason !== undefined ? { abortReason } : {}),
  };
}
