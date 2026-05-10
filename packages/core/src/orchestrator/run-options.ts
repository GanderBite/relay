import type { CostTracker } from '../cost.js';
import type { AbortReason } from '../errors.js';
import type { Flow } from '../flow/types.js';
import type { HandoffStore } from '../handoffs.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AuthState, Provider } from '../providers/types.js';
import type { StateMachine } from '../state.js';

import type { StepResult } from './types.js';

export interface OrchestratorOptions {
  providers?: ProviderRegistry;
  logger?: Logger;
  runDir?: string;
}

/**
 * Options passed to `Orchestrator.run()` and `Orchestrator.resume()`.
 *
 * @remarks RunOptions co-locates with the Orchestrator class that consumes
 * it; defining it in its own module keeps `orchestrator.ts` focused on the
 * class itself.
 */
export interface RunOptions {
  resumeFrom?: string;
  parallelism?: number;
  /**
   * Directory the flow package lives in — used to resolve prompt template
   * paths (step.promptFile) relative to the flow AND to locate the per-flow
   * `settings.json` for provider resolution. Defaults to process.cwd(). Set
   * explicitly when the Orchestrator is embedded in a host process whose cwd
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
   * the cap fires, the Orchestrator raises `AuthTimeoutError` before any step
   * runs. Defaults to 30_000.
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
   * A provider name that has already been resolved by the caller (e.g. the CLI
   * after `loadFlowAndAuth` finishes). When set, the orchestrator's auth
   * bootstrap skips the three-tier settings resolution chain and fetches the
   * provider directly from the registry by this name. Prefer this over
   * `flagProvider` when the caller has already resolved the provider — it
   * avoids redundant settings-file I/O and prevents the two resolution passes
   * from diverging if settings change between the banner and the run.
   *
   * Mutually exclusive with `flagProvider`. `resolvedProviderName` takes
   * precedence when both are set.
   */
  resolvedProviderName?: string | undefined;
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
   */
  worktree?: boolean | 'auto' | undefined;
  /**
   * Lifecycle hook fired after each step completes successfully. Embedding
   * hosts (UIs, dashboards, IDE plugins) use this to subscribe to progress
   * without polling state.json. Errors thrown by the callback are caught and
   * logged at warn level — they never abort or affect the run. Async work
   * inside the callback is the caller's responsibility; the Orchestrator does
   * not await the callback.
   *
   * Result variants are discriminated on `kind` for prompt/parallel/terminal
   * steps and on the script/branch exit-code shape — narrow with
   * `'kind' in result` before reading variant fields.
   */
  onStepComplete?: ((stepId: string, result: StepResult) => void) | undefined;
  /**
   * Pre-verified auth states from a prior authenticate() call, keyed by
   * provider name. When a provider's name is present in this map, the auth
   * bootstrap skips re-authentication for that provider and uses the cached
   * AuthState directly. This avoids a second subprocess spawn when the CLI
   * has already authenticated to render the start banner.
   */
  preAuthedState?: Map<string, AuthState> | undefined;
  /**
   * When false, pino's stdout stream is suppressed and logs are written to
   * the run file only. Set to `!process.stdout.isTTY` from the CLI so that
   * NDJSON does not appear alongside the ProgressDisplay in interactive
   * terminals. Non-TTY callers (CI, pipes) leave this true to preserve NDJSON
   * on stdout. Defaults to true (backward compatible).
   */
  logToStdout?: boolean | undefined;
  /**
   * When true, the per-step event log writer includes the raw stream-json
   * envelope alongside the translated InvocationEvent in each EventRecord.
   * Raw envelopes are large; persisting them on every run wastes disk for
   * runs that will never be inspected in verbose mode. Everything else —
   * writing the event log, rendering progress — is unconditional.
   */
  verbose?: boolean | undefined;
}

export interface RunResult {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed' | 'aborted' | 'paused';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
  /**
   * The first non-abort step error encountered during the walk, captured so
   * embedding hosts can route the error through their own exit-code or
   * formatter helpers without re-throwing the orchestrator's control flow.
   * Typed as the broad `Error` so this field carries every PipelineError
   * subclass verbatim — callers narrow with `instanceof`. Undefined for
   * successful runs, runs aborted via SIGINT/SIGTERM, and any other path that
   * exits without a step error (resume short-circuit, etc.). In-memory only —
   * never persisted to state.json.
   */
  firstError?: Error | undefined;
  /**
   * When `status === 'paused'`, the id of the ask step that triggered the
   * pause. The CLI uses this to render targeted resume guidance
   * (`relay answer <runId>`) without re-reading state.json.
   */
  pausedStepId?: string | undefined;
  /**
   * When `status === 'aborted'`, the typed reason for the abort. Populated
   * at the abort-logging sites in `run()` and `resume()`. Undefined for every
   * other terminal status.
   */
  abortReason?: AbortReason | undefined;
}

/**
 * Context threaded into every per-step executor. Executors receive a tailored
 * subset of this shape; the Orchestrator builds each per-step ctx from this
 * central bag plus the resolved provider binding.
 *
 * Auth is enforced at provider selection: the configured provider's
 * authenticate() runs before the flow starts. No auth escape hatch is
 * threaded through this context.
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
