/**
 * `relay resume <runId>` — resume a failed or interrupted run from its last
 * checkpoint.
 *
 * Pre-resume banner verbatim per product spec §6.7:
 *
 *   ●─▶●─▶●─▶●  relay resume f9c3a2
 *
 *   flow     codebase-discovery v0.1.0
 *   picking up from: designReview
 *
 *    ✓ inventory       (cached, ran 14:32)
 *    ✓ entities        (cached, ran 14:33)
 *    ✓ services        (cached, ran 14:33)
 *    ⠋ designReview    running
 *    ○ report          waiting on designReview
 *
 *   spent so far: $0.049 · resume cost est: $0.33
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuthState, RaceState, RunnerState } from '@relay/core';
import {
  ClaudeAuthError,
  CostTracker,
  defaultRegistry,
  loadGlobalSettings,
  loadRaceSettings,
  loadState,
  Orchestrator,
  RaceStateNotFoundError,
  registerDefaultProviders,
  resolveProvider,
} from '@relay/core';
import {
  type FailureStepRow,
  renderFailureBanner,
  renderSuccessBanner,
  type SuccessStepRow,
} from '../banner.js';
import { exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { renderPausedBanner } from '../paused-banner.js';
import { type AuthInfo, ProgressDisplay } from '../progress.js';
import { gray, green, kvLine, MARK, red, STEP_NAME_WIDTH, SYMBOLS, yellow } from '../visual.js';

// ---------------------------------------------------------------------------
// RaceRef shape — mirrors core/orchestrator/resume.ts RaceRef
// ---------------------------------------------------------------------------

interface RaceRef {
  raceName: string;
  raceVersion: string;
  racePath: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as "HH:MM" in UTC — matches the spec's
 * "(cached, ran 14:32)" display.
 */
function fmtHHMM(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Format a USD amount with 3 decimal places.
 * Used for "spent so far" and "resume cost est" lines.
 */
function fmtUsd(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

/**
 * Find the first runner in topoOrder that is not succeeded/skipped.
 * This is the "picking up from:" runner.
 */
function firstPendingRunnerId(
  topoOrder: readonly string[],
  runners: Record<string, RunnerState>,
): string {
  for (const runnerId of topoOrder) {
    const s = runners[runnerId];
    if (s === undefined) continue;
    if (s.status !== 'succeeded' && s.status !== 'skipped') return runnerId;
  }
  // Fallback: if all succeeded somehow, return the last in order.
  return topoOrder[topoOrder.length - 1] ?? '';
}

/**
 * Render one runner row for the pre-resume static banner.
 *
 * Status rules per §6.7:
 *   succeeded → green "✓ <name padded>  (cached, ran HH:MM)"
 *   failed/pending/running → determined by position in banner:
 *     the first non-succeeded runner is shown as spinning "⠋ <name>    running"
 *     subsequent non-succeeded runners are "○ <name>    waiting on X, Y"
 */
function renderPreResumeRunnerRow(
  runnerId: string,
  stepState: RunnerState,
  isFirstPending: boolean,
  pendingPredecessors: string[],
): string {
  const nameCol = runnerId.padEnd(STEP_NAME_WIDTH);

  if (stepState.status === 'succeeded') {
    const timeStr = stepState.completedAt !== undefined ? fmtHHMM(stepState.completedAt) : '--:--';
    return green(` ${SYMBOLS.ok} ${nameCol}(cached, ran ${timeStr})`);
  }

  if (isFirstPending) {
    // The step we are about to run — show with spinner frame 0.
    const spinnerChar = SYMBOLS.spinner[0];
    return yellow(` ${spinnerChar} ${nameCol}running`);
  }

  // Downstream pending step.
  if (pendingPredecessors.length > 0) {
    const waitList = pendingPredecessors.join(', ');
    return gray(` ${SYMBOLS.pending} ${nameCol}waiting on ${waitList}`);
  }
  return gray(` ${SYMBOLS.pending} ${nameCol}waiting`);
}

/**
 * Load metrics.json from runDir via CostTracker. Returns totalUsd = 0 on
 * any failure — a missing metrics file is not fatal for resume.
 */
async function loadSpentUsd(runDir: string): Promise<number> {
  const metricsPath = join(runDir, 'metrics.json');
  const tracker = new CostTracker(metricsPath);
  const loadResult = await tracker.load();
  if (loadResult.isErr()) return 0;
  return tracker.summary().totalUsd;
}

// ---------------------------------------------------------------------------
// Pre-resume banner
// ---------------------------------------------------------------------------

/**
 * Print the static pre-resume banner to stdout.
 *
 * Reads state.json to determine which runners have already succeeded and which
 * is the first pending runner. Does not invoke the Orchestrator.
 */
function printPreResumeBanner(
  runId: string,
  raceRef: RaceRef,
  state: RaceState,
  topoOrder: readonly string[],
  predecessors: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  spentUsd: number,
): void {
  const pickingUpFrom = firstPendingRunnerId(topoOrder, state.runners);

  // Header: "●─▶●─▶●─▶●  relay resume f9c3a2"
  process.stdout.write(`${MARK}  relay resume ${runId}\n`);
  process.stdout.write('\n');

  // KV rows — "race" uses kvLine for column alignment; "picking up from:" does not.
  process.stdout.write(kvLine('race', `${raceRef.raceName} v${raceRef.raceVersion}`) + '\n');
  process.stdout.write(`picking up from: ${pickingUpFrom}\n`);
  process.stdout.write('\n');

  // Runner grid.
  let foundFirstPending = false;
  for (const runnerId of topoOrder) {
    const stepState = state.runners[runnerId];
    if (stepState === undefined) continue;

    const isFirstPending =
      !foundFirstPending && stepState.status !== 'succeeded' && stepState.status !== 'skipped';

    if (isFirstPending) foundFirstPending = true;

    // Compute pending predecessors for the "waiting on" line.
    // Only needed for non-first non-succeeded runners.
    let pendingPredecessors: string[] = [];
    if (!isFirstPending && stepState.status !== 'succeeded' && stepState.status !== 'skipped') {
      if (predecessors !== undefined) {
        // Use actual graph edges — only direct parents that are not yet done.
        const directParents = predecessors.get(runnerId);
        if (directParents !== undefined) {
          pendingPredecessors = [...directParents].filter((predId) => {
            const predState = state.runners[predId];
            return (
              predState !== undefined &&
              predState.status !== 'succeeded' &&
              predState.status !== 'skipped'
            );
          });
        }
      } else {
        // Fallback: topoOrder heuristic when the graph does not expose predecessors.
        const ownIndex = topoOrder.indexOf(runnerId);
        pendingPredecessors = topoOrder.slice(0, ownIndex).filter((predId) => {
          const predState = state.runners[predId];
          return (
            predState !== undefined &&
            predState.status !== 'succeeded' &&
            predState.status !== 'skipped'
          );
        });
      }
    }

    const row = renderPreResumeRunnerRow(runnerId, stepState, isFirstPending, pendingPredecessors);
    process.stdout.write(row + '\n');
  }

  process.stdout.write('\n');

  // Footer: honest "spent so far" only — no fabricated cost estimate.
  const spentStr = fmtUsd(spentUsd);
  process.stdout.write(`spent so far: ${spentStr}\n`);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export interface ResumeCommandOptions {
  /** Provider name from --provider flag. Takes precedence over all settings. */
  provider?: string;
  /**
   * Commander flips this to `false` when the user passes `--no-worktree`.
   * Undefined or true leaves the Orchestrator default ('auto') in effect.
   */
  worktree?: boolean;
}

/**
 * Entry point for `relay resume <runId>`.
 */
export default async function resumeCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as ResumeCommandOptions;
  // ---- (1) Parse runId ----
  const runId = typeof args[0] === 'string' ? args[0] : undefined;
  if (runId === undefined || runId.trim() === '') {
    process.stderr.write(red(`  ${SYMBOLS.fail} relay resume requires a run id`) + '\n');
    process.stderr.write(gray('  relay runs') + '\n');
    process.exit(1);
  }

  const runDir = join(process.cwd(), '.relay', 'runs', runId);

  // ---- (2) Load state.json ----
  const stateResult = await loadState(runDir);
  if (stateResult.isErr()) {
    const e = stateResult.error;
    if (e instanceof RaceStateNotFoundError) {
      process.stderr.write(red(`  ${SYMBOLS.fail} no resumable run at ${runId}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    } else {
      process.stderr.write(
        red(`  ${SYMBOLS.fail} could not read run state for ${runId}: ${e.message}`) + '\n',
      );
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    }
    process.exit(1);
  }
  const state = stateResult.value;

  // ---- (3) Load race-ref.json ----
  let raceRef: RaceRef;
  try {
    const raw = await readFile(join(runDir, 'race-ref.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>)['raceName'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['raceVersion'] !== 'string'
    ) {
      throw new Error('race-ref.json is malformed');
    }
    const p = parsed as Record<string, unknown>;
    raceRef = {
      raceName: p['raceName'] as string,
      raceVersion: p['raceVersion'] as string,
      racePath: typeof p['racePath'] === 'string' ? p['racePath'] : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load race-ref.json for run ${runId}: ${msg}`) + '\n',
    );
    process.stderr.write(gray('  did you mean: relay runs') + '\n');
    process.exit(1);
  }

  if (raceRef.racePath === null) {
    process.stderr.write(
      red(`  ${SYMBOLS.fail} run ${runId} has no recorded race path — cannot resume`) + '\n',
    );
    process.stderr.write(gray('  start a fresh run: relay run ' + raceRef.raceName + ' .') + '\n');
    process.exit(1);
  }

  // ---- (4) Load the race module ----
  const flowResult = await loadFlow(raceRef.racePath, process.cwd());
  if (flowResult.isErr()) {
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load race for run ${runId}: ${flowResult.error.message}`) +
        '\n',
    );
    process.stderr.write(gray('  ensure the race package is built: pnpm build') + '\n');
    process.exit(1);
  }
  const { flow } = flowResult.value;

  // ---- (5) Load spent cost from metrics.json ----
  const spentUsd = await loadSpentUsd(runDir);

  // ---- (6) Print pre-resume banner ----
  printPreResumeBanner(
    runId,
    raceRef,
    state,
    flow.graph.topoOrder,
    flow.graph.predecessors,
    spentUsd,
  );

  // ---- (7) Auth check — must happen before the Orchestrator so we can exit 3 on auth failure ----
  // Resolve the provider via the same chain Orchestrator.resume() uses below
  // (--provider flag > race settings > global settings) so any auth failure
  // surfaces here with a clean exit code rather than mid-resume.
  registerDefaultProviders();
  const flowDirForSettings = dirname(raceRef.racePath);
  const globalSettingsResult = await loadGlobalSettings();
  if (globalSettingsResult.isErr()) {
    process.stderr.write(formatError(globalSettingsResult.error) + '\n');
    process.exit(exitCodeFor(globalSettingsResult.error));
  }
  const raceSettingsResult = await loadRaceSettings(flowDirForSettings);
  if (raceSettingsResult.isErr()) {
    process.stderr.write(formatError(raceSettingsResult.error) + '\n');
    process.exit(exitCodeFor(raceSettingsResult.error));
  }
  const resolverArgs: Parameters<typeof resolveProvider>[0] = {
    raceSettings: raceSettingsResult.value,
    globalSettings: globalSettingsResult.value,
    registry: defaultRegistry,
  };
  if (options.provider !== undefined) {
    resolverArgs.flagProvider = options.provider;
  }
  const providerResult = resolveProvider(resolverArgs);
  let auth: AuthState | undefined;
  if (providerResult.isOk()) {
    const authResult = await providerResult.value.authenticate();
    if (authResult.isErr()) {
      const authErr = authResult.error;
      if (authErr instanceof ClaudeAuthError) {
        process.stderr.write(formatError(authErr) + '\n');
        process.exit(3);
      }
      process.stderr.write(formatError(authErr) + '\n');
      process.exit(exitCodeFor(authErr));
    }
    auth = authResult.value;
  } else {
    // Surface NoProviderConfiguredError up front; falling through with no
    // provider would silently downgrade the bill row to a fabricated
    // subscription state and then crash the resume mid-walk.
    process.stderr.write(formatError(providerResult.error) + '\n');
    process.exit(exitCodeFor(providerResult.error));
  }

  const effectiveAuth: AuthState = auth;

  // ---- (8) Construct Orchestrator and start progress display ----
  const orchestrator = new Orchestrator({ runDir });

  const authInfo: AuthInfo = {
    label: effectiveAuth.billingSource === 'subscription' ? 'subscription (max)' : `api account`,
    estUsd: 0,
  };

  const display = new ProgressDisplay(runDir, flow, authInfo);
  display.start(runId);

  // ---------------------------------------------------------------------------
  // SIGINT handler — Ctrl-C paused UX (product spec §11.5)
  //
  // First ^C: flag the interruption. The Orchestrator registers its own SIGINT
  // listener and fires its AbortController, which causes orchestrator.resume()
  // to resolve with status = 'aborted'. We detect that below and render the
  // paused banner instead of the failure banner.
  //
  // Second ^C within 2 s: hard exit 130 (SIGINT convention).
  // ---------------------------------------------------------------------------
  let wasInterrupted = false;
  let lastSigintMs = 0;

  const sigintHandler = (): void => {
    const now = Date.now();
    if (!wasInterrupted || now - lastSigintMs > 2000) {
      wasInterrupted = true;
      lastSigintMs = now;
      // The Runner's own SIGINT handler fires simultaneously and aborts the run.
    } else {
      // Second ^C within 2 s — hard exit.
      process.exit(130);
    }
  };

  process.on('SIGINT', sigintHandler);

  let exitCode = 0;
  try {
    const resumeOpts: Parameters<typeof orchestrator.resume>[1] = {};
    if (options.provider !== undefined) {
      resumeOpts.flagProvider = options.provider;
    }
    if (options.worktree === false) {
      resumeOpts.worktree = false;
    }
    const result = await orchestrator.resume(runDir, resumeOpts);

    process.removeListener('SIGINT', sigintHandler);
    display.stop();

    // ---- (9) Post-resume banner ----
    if (result.status === 'succeeded') {
      // Re-read the final state for accurate per-step timing.
      const finalStateResult = await loadState(runDir);
      const finalState = finalStateResult.isOk() ? finalStateResult.value : state;

      const stepRows: SuccessStepRow[] = flow.graph.topoOrder.map((runnerId) => {
        const stepState = finalState.runners[runnerId];
        return {
          name: runnerId,
          model: 'sonnet',
          durationMs:
            stepState?.completedAt !== undefined && stepState.startedAt !== undefined
              ? new Date(stepState.completedAt).getTime() - new Date(stepState.startedAt).getTime()
              : 0,
          costUsd: 0,
        };
      });

      const outputPath = result.artifacts[0] ?? `.relay/runs/${runId}`;

      process.stdout.write(
        renderSuccessBanner({
          raceName: raceRef.raceName,
          runId,
          steps: stepRows,
          totalDurationMs: result.durationMs,
          totalCostUsd: result.cost.totalUsd,
          auth: effectiveAuth,
          outputPath,
        }),
      );
    } else if (result.status === 'aborted' && wasInterrupted) {
      // Ctrl-C paused — render paused banner, exit 130 (SIGINT convention).
      // This is not an error: state is saved, the run can be resumed.
      await renderPausedBanner(raceRef.raceName, runId, runDir, flow.graph.topoOrder);
      process.exit(130);
    } else {
      // Re-read final state for accurate step statuses after the run.
      const finalStateResult = await loadState(runDir);
      const finalState = finalStateResult.isOk() ? finalStateResult.value : state;

      const failureSteps: FailureStepRow[] = flow.graph.topoOrder.map((runnerId) => {
        const stepState = finalState.runners[runnerId];
        const stepStatus: FailureStepRow['status'] =
          stepState?.status === 'succeeded'
            ? 'succeeded'
            : stepState?.status === 'failed'
              ? 'failed'
              : 'skipped';
        return {
          name: runnerId,
          status: stepStatus,
          model: 'sonnet',
          durationMs:
            stepState?.completedAt !== undefined && stepState.startedAt !== undefined
              ? new Date(stepState.completedAt).getTime() - new Date(stepState.startedAt).getTime()
              : 0,
          costUsd: 0,
        };
      });

      process.stdout.write(
        renderFailureBanner({
          raceName: raceRef.raceName,
          runId,
          steps: failureSteps,
          spentUsd: result.cost.totalUsd,
        }),
      );

      exitCode = 1;
    }
  } catch (caught) {
    process.removeListener('SIGINT', sigintHandler);
    display.stop();
    process.stderr.write(formatError(caught) + '\n');
    exitCode = exitCodeFor(caught);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
