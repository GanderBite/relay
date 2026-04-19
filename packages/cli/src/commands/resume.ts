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
import { join } from 'node:path';

import {
  ClaudeAuthError,
  CostTracker,
  defaultRegistry,
  loadState,
  registerDefaultProviders,
  Runner,
  StateNotFoundError,
} from '@relay/core';
import type { AuthState, RunState, StepState } from '@relay/core';

import { exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import {
  ProgressDisplay,
  type AuthInfo,
} from '../progress.js';
import {
  renderFailureBanner,
  renderSuccessBanner,
  type FailureStepRow,
  type SuccessStepRow,
} from '../banner.js';
import {
  MARK,
  SYMBOLS,
  STEP_NAME_WIDTH,
  gray,
  green,
  red,
  yellow,
  kvLine,
} from '../visual.js';

// ---------------------------------------------------------------------------
// FlowRef shape — mirrors core/runner/resume.ts FlowRef
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
 */
function firstPendingStepId(
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
 * Status rules per §6.7:
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
    const timeStr =
      stepState.completedAt !== undefined ? fmtHHMM(stepState.completedAt) : '--:--';
    return green(` ${SYMBOLS.ok} ${nameCol}(cached, ran ${timeStr})`);
  }

  if (isFirstPending) {
    // The step we are about to run — show with spinner frame 0.
    const spinnerChar = SYMBOLS.spinner[0] ?? SYMBOLS.spinner[0];
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
 * Reads state.json to determine which steps have already succeeded and which
 * is the first pending step. Does not invoke the Runner.
 */
function printPreResumeBanner(
  runId: string,
  flowRef: FlowRef,
  state: RunState,
  topoOrder: readonly string[],
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
      !foundFirstPending &&
      stepState.status !== 'succeeded' &&
      stepState.status !== 'skipped';

    if (isFirstPending) foundFirstPending = true;

    // Compute pending predecessors for the "waiting on" line.
    // Only needed for non-first non-succeeded steps.
    let pendingPredecessors: string[] = [];
    if (!isFirstPending && stepState.status !== 'succeeded' && stepState.status !== 'skipped') {
      const step = state.steps;
      pendingPredecessors = topoOrder.filter((predId) => {
        const predState = step[predId];
        return (
          predId !== stepId &&
          predState !== undefined &&
          predState.status !== 'succeeded' &&
          predState.status !== 'skipped'
        );
      }).filter((predId) => {
        // Only include direct predecessors — we check this by picking
        // steps that appear before this step in topoOrder and are not done.
        const ownIndex = topoOrder.indexOf(stepId);
        const predIndex = topoOrder.indexOf(predId);
        return predIndex < ownIndex;
      });
    }

    const row = renderPreResumeStepRow(stepId, stepState, isFirstPending, pendingPredecessors);
    process.stdout.write(row + '\n');
  }

  process.stdout.write('\n');

  // Footer: "spent so far: $0.049 · resume cost est: $?.??"
  const spentStr = fmtUsd(spentUsd);
  process.stdout.write(
    `spent so far: ${spentStr} ${SYMBOLS.dot} resume cost est: $?.??\n`,
  );
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay resume <runId>`.
 */
export default async function resumeCommand(
  args: unknown[],
  _opts: unknown,
): Promise<void> {
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
    if (e instanceof StateNotFoundError) {
      process.stderr.write(red(`  ${SYMBOLS.fail} no resumable run at ${runId}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    } else {
      process.stderr.write(red(`  ${SYMBOLS.fail} could not read run state for ${runId}: ${e.message}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    }
    process.exit(1);
  }
  const state = stateResult.value;

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
      flowPath:
        typeof p['flowPath'] === 'string' ? p['flowPath'] : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(red(`  ${SYMBOLS.fail} could not load flow-ref.json for run ${runId}: ${msg}`) + '\n');
    process.stderr.write(gray('  did you mean: relay runs') + '\n');
    process.exit(1);
  }

  if (flowRef.flowPath === null) {
    process.stderr.write(
      red(`  ${SYMBOLS.fail} run ${runId} has no recorded flow path — cannot resume`) + '\n',
    );
    process.stderr.write(
      gray('  start a fresh run: relay run ' + flowRef.flowName + ' .') + '\n',
    );
    process.exit(1);
  }

  // ---- (4) Load the flow module ----
  const flowResult = await loadFlow(flowRef.flowPath, process.cwd());
  if (flowResult.isErr()) {
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load flow for run ${runId}: ${flowResult.error.message}`) + '\n',
    );
    process.stderr.write(
      gray('  ensure the flow package is built: pnpm build') + '\n',
    );
    process.exit(1);
  }
  const { flow } = flowResult.value;

  // ---- (5) Load spent cost from metrics.json ----
  const spentUsd = await loadSpentUsd(runDir);

  // ---- (6) Print pre-resume banner ----
  printPreResumeBanner(runId, flowRef, state, flow.graph.topoOrder, spentUsd);

  // ---- (7) Auth check — must happen before the Runner so we can exit 3 on auth failure ----
  registerDefaultProviders();
  const providerResult = defaultRegistry.get('claude');
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
  }

  // Fallback synthetic AuthState when no provider is registered.
  const effectiveAuth: AuthState = auth ?? {
    ok: true,
    billingSource: 'subscription',
    detail: 'subscription (max)',
  };

  // ---- (8) Construct Runner and start progress display ----
  const runner = new Runner({ runDir });

  const authInfo: AuthInfo = {
    label:
      effectiveAuth.billingSource === 'subscription'
        ? 'subscription (max)'
        : `api account`,
    estUsd: 0,
  };

  const display = new ProgressDisplay(runDir, flow, authInfo);
  display.start(runId);

  let exitCode = 0;
  try {
    const result = await runner.resume(runDir);

    display.stop();

    // ---- (9) Post-resume banner ----
    if (result.status === 'succeeded') {
      // Re-read the final state for accurate per-step timing.
      const finalStateResult = await loadState(runDir);
      const finalState = finalStateResult.isOk() ? finalStateResult.value : state;

      const stepRows: SuccessStepRow[] = flow.graph.topoOrder.map((stepId) => {
        const stepState = finalState.steps[stepId];
        return {
          name: stepId,
          model: 'sonnet',
          durationMs:
            stepState?.completedAt !== undefined && stepState.startedAt !== undefined
              ? new Date(stepState.completedAt).getTime() -
                new Date(stepState.startedAt).getTime()
              : 0,
          costUsd: 0,
        };
      });

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
    } else {
      // Re-read final state for accurate step statuses after the run.
      const finalStateResult = await loadState(runDir);
      const finalState = finalStateResult.isOk() ? finalStateResult.value : state;

      const failureSteps: FailureStepRow[] = flow.graph.topoOrder.map((stepId) => {
        const stepState = finalState.steps[stepId];
        const stepStatus: FailureStepRow['status'] =
          stepState?.status === 'succeeded'
            ? 'succeeded'
            : stepState?.status === 'failed'
              ? 'failed'
              : 'skipped';
        return {
          name: stepId,
          status: stepStatus,
          model: 'sonnet',
          durationMs:
            stepState?.completedAt !== undefined && stepState.startedAt !== undefined
              ? new Date(stepState.completedAt).getTime() -
                new Date(stepState.startedAt).getTime()
              : 0,
          costUsd: 0,
        };
      });

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
    display.stop();
    process.stderr.write(formatError(caught) + '\n');
    exitCode = exitCodeFor(caught);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
