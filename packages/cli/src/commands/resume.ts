/**
 * `relay resume <runId>` — resume a failed or interrupted run from its last
 * checkpoint.
 *
 * Pre-resume banner — verbatim string contract; the file is the canonical reference:
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
import type { AuthState, RunState, StepState } from '@ganderbite/relay-core';
import { CostTracker, loadState, Orchestrator, StateNotFoundError } from '@ganderbite/relay-core';
import { renderFailureBanner, renderSuccessBanner } from '../banner.js';
import { MARK, SYMBOLS } from '../brand.js';
import { gray, green, red, yellow } from '../color.js';
import { EXIT_CODES, exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { kvLine, STEP_NAME_WIDTH } from '../layout.js';
import { authenticateProvider } from '../load-flow-and-auth.js';
import { renderPausedBanner } from '../paused-banner.js';
import { type AuthInfo, ProgressDisplay } from '../progress.js';
import { buildFailureStepRows, buildSuccessStepRows } from '../step-data.js';

// ---------------------------------------------------------------------------
// FlowRef shape — mirrors core/orchestrator/resume.ts FlowRef
// ---------------------------------------------------------------------------

interface FlowRef {
  flowName: string;
  flowVersion: string;
  flowPath: string | null;
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
 * Find the first step in topoOrder that is not succeeded/skipped.
 * This is the "picking up from:" step.
 *
 * Exported for testing.
 */
export function firstPendingStepId(
  topoOrder: readonly string[],
  steps: Record<string, StepState>,
): string {
  for (const stepId of topoOrder) {
    const s = steps[stepId];
    if (s === undefined) continue;
    if (s.status !== 'succeeded' && s.status !== 'skipped') return stepId;
  }
  // Fallback: if all succeeded somehow, return the last in order.
  return topoOrder[topoOrder.length - 1] ?? '';
}

/**
 * Render one step row for the pre-resume static banner.
 *
 * Status rules for the pre-resume step grid:
 *   succeeded → green "✓ <name padded>  (cached, ran HH:MM)"
 *   failed/pending/running → determined by position in banner:
 *     the first non-succeeded step is shown as spinning "⠋ <name>    running"
 *     subsequent non-succeeded steps are "○ <name>    waiting on X, Y"
 */
function renderPreResumeStepRow(
  stepId: string,
  stepState: StepState,
  isFirstPending: boolean,
  pendingPredecessors: string[],
): string {
  const nameCol = stepId.padEnd(STEP_NAME_WIDTH);

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
  flowRef: FlowRef,
  state: RunState,
  topoOrder: readonly string[],
  predecessors: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  spentUsd: number,
): void {
  const pickingUpFrom = firstPendingStepId(topoOrder, state.steps);

  // Header: "●─▶●─▶●─▶●  relay resume f9c3a2"
  process.stdout.write(`${MARK}  relay resume ${runId}\n`);
  process.stdout.write('\n');

  // KV rows — "flow" uses kvLine for column alignment; "picking up from:" does not.
  process.stdout.write(kvLine('flow', `${flowRef.flowName} v${flowRef.flowVersion}`) + '\n');
  process.stdout.write(`picking up from: ${pickingUpFrom}\n`);
  process.stdout.write('\n');

  // Step grid.
  let foundFirstPending = false;
  for (const stepId of topoOrder) {
    const stepState = state.steps[stepId];
    if (stepState === undefined) continue;

    const isFirstPending =
      !foundFirstPending && stepState.status !== 'succeeded' && stepState.status !== 'skipped';

    if (isFirstPending) foundFirstPending = true;

    // Compute pending predecessors for the "waiting on" line.
    // Only needed for non-first non-succeeded steps.
    let pendingPredecessors: string[] = [];
    if (!isFirstPending && stepState.status !== 'succeeded' && stepState.status !== 'skipped') {
      if (predecessors !== undefined) {
        // Use actual graph edges — only direct parents that are not yet done.
        const directParents = predecessors.get(stepId);
        if (directParents !== undefined) {
          pendingPredecessors = [...directParents].filter((predId) => {
            const predState = state.steps[predId];
            return (
              predState !== undefined &&
              predState.status !== 'succeeded' &&
              predState.status !== 'skipped'
            );
          });
        }
      } else {
        // Fallback: topoOrder heuristic when the graph does not expose predecessors.
        const ownIndex = topoOrder.indexOf(stepId);
        pendingPredecessors = topoOrder.slice(0, ownIndex).filter((predId) => {
          const predState = state.steps[predId];
          return (
            predState !== undefined &&
            predState.status !== 'succeeded' &&
            predState.status !== 'skipped'
          );
        });
      }
    }

    const row = renderPreResumeStepRow(stepId, stepState, isFirstPending, pendingPredecessors);
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
  /** When true, render the verbose event sub-stream under each running step. */
  verbose?: boolean;
}

/**
 * Entry point for `relay resume <runId>`.
 */
export default async function resumeCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as ResumeCommandOptions;
  // ---- (1) Parse runId ----
  const runId = typeof args[0] === 'string' ? args[0] : undefined;
  if (runId === undefined || runId.trim() === '') {
    // usage-error: formatError does not apply — missing argument is not a PipelineError type
    process.stderr.write(red(`  ${SYMBOLS.fail} relay resume requires a run id`) + '\n');
    process.stderr.write(gray('  relay runs') + '\n');
    process.exit(1);
  }

  const runDir = join(process.cwd(), '.relay', 'runs', runId);

  // ---- (2) Load state.json ----
  const stateResult = await loadState(runDir);
  if (stateResult.isErr()) {
    const e = stateResult.error;
    if (e instanceof StateNotFoundError) {
      // usage-error: formatError does not apply — StateNotFoundError is not a PipelineError type
      process.stderr.write(red(`  ${SYMBOLS.fail} no resumable run at ${runId}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    } else {
      // usage-error: formatError does not apply — generic I/O error reading state, no PipelineError type
      process.stderr.write(
        red(`  ${SYMBOLS.fail} could not read run state for ${runId}: ${e.message}`) + '\n',
      );
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    }
    process.exit(1);
  }
  const state = stateResult.value;

  // ---- (2b) Refuse paused runs — relay resume cannot resume an ask-paused run ----
  if (state.status === 'paused') {
    process.stderr.write(yellow(`  ${SYMBOLS.warn} this run is paused waiting for input`) + '\n');
    process.stderr.write(gray(`  provide answers with: relay answer ${runId}`) + '\n');
    process.exit(1);
  }

  // ---- (3) Load flow-ref.json ----
  let flowRef: FlowRef;
  try {
    const raw = await readFile(join(runDir, 'flow-ref.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>)['flowName'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['flowVersion'] !== 'string'
    ) {
      throw new Error('flow-ref.json is malformed');
    }
    const p = parsed as Record<string, unknown>;
    flowRef = {
      flowName: p['flowName'] as string,
      flowVersion: p['flowVersion'] as string,
      flowPath: typeof p['flowPath'] === 'string' ? p['flowPath'] : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // usage-error: formatError does not apply — malformed or missing flow-ref.json, not a PipelineError type
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load flow-ref.json for run ${runId}: ${msg}`) + '\n',
    );
    process.stderr.write(gray('  did you mean: relay runs') + '\n');
    process.exit(1);
  }

  if (flowRef.flowPath === null) {
    // usage-error: formatError does not apply — missing flowPath in persisted ref, not a PipelineError type
    process.stderr.write(
      red(`  ${SYMBOLS.fail} run ${runId} has no recorded flow path — cannot resume`) + '\n',
    );
    process.stderr.write(gray('  start a fresh run: relay run ' + flowRef.flowName + ' .') + '\n');
    process.exit(1);
  }

  // ---- (4) Load the flow module ----
  const flowResult = await loadFlow(flowRef.flowPath, process.cwd());
  if (flowResult.isErr()) {
    process.stderr.write(formatError(flowResult.error) + '\n');
    process.exit(exitCodeFor(flowResult.error));
  }
  const { flow } = flowResult.value;

  // ---- (5) Load spent cost from metrics.json ----
  const spentUsd = await loadSpentUsd(runDir);

  // ---- (6) Print pre-resume banner ----
  printPreResumeBanner(
    runId,
    flowRef,
    state,
    flow.graph.topoOrder,
    flow.graph.predecessors,
    spentUsd,
  );

  // ---- (7) Auth check — must happen before the Orchestrator so we can exit 3 on auth failure ----
  // Resolve the provider via the same chain Orchestrator.resume() uses below
  // (--provider flag > flow settings > global settings) so any auth failure
  // surfaces here with a clean exit code rather than mid-resume.
  const flowDirForSettings = dirname(flowRef.flowPath);
  const authCheckResult = await authenticateProvider({
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    flowDir: flowDirForSettings,
  });
  if (authCheckResult.isErr()) {
    process.stderr.write(formatError(authCheckResult.error) + '\n');
    process.exit(exitCodeFor(authCheckResult.error));
  }

  const { resolvedProvider, authState: effectiveAuth } = authCheckResult.value;

  // ---- (8) Construct Orchestrator and start progress display ----
  const orchestrator = new Orchestrator({ runDir });

  const authInfo: AuthInfo = {
    label: effectiveAuth.billingSource === 'subscription' ? 'subscription (max)' : `api account`,
    estUsd: 0,
  };

  const display = new ProgressDisplay(runDir, flow, authInfo, options.verbose === true);
  display.start(runId);

  // ---------------------------------------------------------------------------
  // SIGINT handler — Ctrl-C paused UX.
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
    const resumeOpts: Parameters<typeof orchestrator.resume>[1] = {
      logToStdout: !process.stdout.isTTY,
    };
    resumeOpts.resolvedProviderName = resolvedProvider.name;
    if (options.worktree === false) {
      resumeOpts.worktree = false;
    }
    if (options.verbose === true) {
      resumeOpts.verbose = true;
    }
    const preAuthedMap = new Map<string, AuthState>();
    preAuthedMap.set(resolvedProvider.name, effectiveAuth);
    resumeOpts.preAuthedState = preAuthedMap;
    resumeOpts.onStepComplete = (stepId, stepResult) => {
      if ('kind' in stepResult && stepResult.kind === 'prompt') {
        display.updateRunnerMetrics(stepId, {
          tokensIn: stepResult.tokensIn,
          tokensOut: stepResult.tokensOut,
          costUsd: stepResult.costUsd,
          durationMs: stepResult.durationMs,
          model: stepResult.model,
        });
      }
    };
    const result = await orchestrator.resume(runDir, resumeOpts);

    process.removeListener('SIGINT', sigintHandler);
    // await so the events-file watcher fully drains before the banner prints
    await display.stop();

    // ---- (9) Post-resume banner ----
    if (result.status === 'succeeded') {
      const stepRows = await buildSuccessStepRows(runDir, [...flow.graph.topoOrder]);
      const outputPath = result.artifacts[0] ?? `.relay/runs/${runId}`;

      process.stdout.write(
        renderSuccessBanner({
          flowName: flowRef.flowName,
          runId,
          steps: stepRows,
          totalDurationMs: result.durationMs,
          totalCostUsd: result.cost.totalUsd,
          auth: effectiveAuth,
          outputPath,
        }),
      );
    } else if (result.status === 'paused') {
      // A step.ask was encountered mid-resume. In an interactive TTY, prompt
      // for answers inline. In non-TTY callers, exit 75 so the caller detects
      // the pause.
      if (process.stdout.isTTY && process.stdin.isTTY) {
        process.stdout.write(`  ${SYMBOLS.dot} paused for input — answering inline\n`);
        const { default: answerCommand } = await import('./answer.js');
        await answerCommand([runId], { verbose: options.verbose });
        return;
      }
      await renderPausedBanner(
        flowRef.flowName,
        runId,
        runDir,
        [...flow.graph.topoOrder],
        result.pausedStepId !== undefined ? { stepId: result.pausedStepId } : undefined,
      );
      process.exit(EXIT_CODES.paused);
    } else if (result.status === 'aborted' && wasInterrupted) {
      // Ctrl-C paused — render paused banner, exit 130 (SIGINT convention).
      // This is not an error: state is saved, the run can be resumed.
      await renderPausedBanner(flowRef.flowName, runId, runDir, flow.graph.topoOrder);
      process.exit(130);
    } else {
      const failureSteps = await buildFailureStepRows(runDir, [...flow.graph.topoOrder]);

      process.stdout.write(
        renderFailureBanner({
          flowName: flowRef.flowName,
          runId,
          steps: failureSteps,
          spentUsd: result.cost.totalUsd,
        }),
      );

      exitCode = 1;
    }
  } catch (caught) {
    process.removeListener('SIGINT', sigintHandler);
    // await so the events-file watcher fully drains before the banner prints
    await display.stop();
    process.stderr.write(formatError(caught) + '\n');
    exitCode = exitCodeFor(caught);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
