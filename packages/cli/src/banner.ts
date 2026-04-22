/**
 * Pre-run, success, and failure banners for the Relay CLI.
 *
 * All brand constants (MARK, WORDMARK, SYMBOLS) and color helpers are
 * imported from visual.ts — never defined here.
 */

import type { AuthState, CostEstimate } from '@relay/core';
import {
  WORDMARK,
  SYMBOLS,
  STEP_NAME_WIDTH,
  MODEL_WIDTH,
  DURATION_WIDTH,
  gray,
  green,
  red,
  rule,
  kvLine,
  flowHeader,
} from './visual.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a duration in milliseconds as "<N>s" (under 60s) or "<M>m <N>s".
 * No rounding for vibes — exact seconds.
 */
function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/**
 * Formats a per-step cost in USD to 3 decimal places using ceiling rounding.
 * Ceiling ensures displayed cost is never under-stated.
 * Example: $0.005
 */
function fmtStepCost(usd: number): string {
  const ceiled = Math.ceil(usd * 1000) / 1000;
  return `$${ceiled.toFixed(3)}`;
}

/**
 * Formats a total/summary cost in USD to 2 decimal places using ceiling rounding.
 * Ceiling ensures displayed cost is never under-stated.
 * Example: $0.38 for a run total, $0.40 for a pre-run estimate.
 */
function fmtTotalCost(usd: number): string {
  const ceiled = Math.ceil(usd * 100) / 100;
  return `$${ceiled.toFixed(2)}`;
}

/**
 * Formats an ISO date-time string to "YYYY-MM-DD HH:mmZ" in UTC.
 * Appending Z makes the timezone unambiguous.
 */
function fmtIsoToUtc(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}Z`;
}

// ---------------------------------------------------------------------------
// Per-step data shapes used by success/failure banners
// ---------------------------------------------------------------------------

/** Data for one completed step line in the success banner. */
export interface SuccessStepRow {
  name: string;
  model: string;
  durationMs: number;
  costUsd: number;
}

/** Data for one step line in the failure banner. */
export interface FailureStepRow {
  name: string;
  /** 'succeeded' | 'failed' | 'skipped' — pending/running steps are not shown post-run */
  status: 'succeeded' | 'failed' | 'skipped';
  model: string;
  durationMs: number;
  costUsd: number;
  /**
   * For failed steps: the process exit code. Shown in the model column as
   * "exit N" (e.g. "exit 1"): `✕ designReview    exit 1     0.2s`
   */
  exitCode?: number;
  /**
   * Only present on the failed runner. The first line names the error class
   * and branch; the second names the specific field or baton.
   * Example:
   *   "branch 'entities' raised BatonSchemaError"
   *   "baton 'entities' missing required field: entities[3].language"
   */
  errorLines?: [string, string];
}

// ---------------------------------------------------------------------------
// renderStartBanner
// ---------------------------------------------------------------------------

export interface StartBannerOptions {
  /** Flow name, e.g. "codebase-discovery". */
  flowName: string;
  /** Flow version, e.g. "0.1.0". */
  flowVersion: string;
  /** Short run id (6-hex), e.g. "f9c3a2". */
  runId: string;
  /** ISO timestamp the run started, e.g. new Date().toISOString(). */
  startedAt: string;
  /**
   * Primary input descriptor, e.g. "." for a directory.
   * Shown before the extras list.
   */
  inputPrimary: string;
  /**
   * Extra input key=value pairs, shown in parentheses.
   * e.g. ["audience=both"]
   * Omit or pass [] to suppress the parenthesised block.
   */
  inputExtras?: string[];
  /** Auth/billing state from provider.authenticate(). */
  auth: AuthState;
  /** Optional pre-run cost estimate. */
  costEstimate?: CostEstimate;
  /** Number of steps in the flow. */
  stepCount: number;
  /**
   * Estimated duration in minutes.
   * Rendered as "~<N> min" in the est row.
   */
  etaMin: number;
}

/**
 * Produces the pre-run banner. Shows billing source, cost estimate, and step
 * count before any tokens are spent.
 *
 * Example output:
 *
 *   ●─▶●─▶●─▶●  relay
 *
 *   race     codebase-discovery v0.1.0
 *   input    .  (audience=both)
 *   run      f9c3a2  ·  2026-04-17 14:32Z
 *   bill     subscription (max)  ·  no api charges
 *   est      $0.40  ·  5 runners  ·  ~12 min
 *
 *   press ctrl-c any time — state is saved after every runner.
 *   ───────────────────────────────────────────────────────
 */
export function renderStartBanner(opts: StartBannerOptions): string {
  const {
    flowName,
    flowVersion,
    runId,
    startedAt,
    inputPrimary,
    inputExtras,
    auth,
    costEstimate,
    stepCount,
    etaMin,
  } = opts;

  // race row
  const flowValue = `${flowName} v${flowVersion}`;

  // input row — "primary  (key=val, key=val)" or just "primary"
  const extras =
    inputExtras !== undefined && inputExtras.length > 0
      ? `  (${inputExtras.join(', ')})`
      : '';
  const inputValue = `${inputPrimary}${extras}`;

  // run row — "<runId>  ·  YYYY-MM-DD HH:mmZ"
  const runValue = `${runId}  ${SYMBOLS.dot}  ${fmtIsoToUtc(startedAt)}`;

  // bill row — NEVER silent
  // subscription → "subscription (max)  ·  no api charges"
  // api-account (and anything else) → "api account  ·  billing applies"
  const billValue =
    auth.billingSource === 'subscription'
      ? `subscription (max)  ${SYMBOLS.dot}  no api charges`
      : `api account  ${SYMBOLS.dot}  billing applies`;

  // est row — "$X.XX  ·  N runners  ·  ~M min" (2-decimal total cost)
  // Only rendered when a real CostEstimate is provided — never show a fake placeholder.
  const estLine =
    costEstimate !== undefined
      ? kvLine(
          'est',
          `${fmtTotalCost(costEstimate.maxUsd)}  ${SYMBOLS.dot}  ${stepCount} runners  ${SYMBOLS.dot}  ~${etaMin} min`,
        )
      : undefined;

  const lines: string[] = [
    WORDMARK,
    '',
    kvLine('race', flowValue),
    kvLine('input', inputValue),
    kvLine('run', runValue),
    kvLine('bill', billValue),
    ...(estLine !== undefined ? [estLine] : []),
    '',
    gray('press ctrl-c any time — state is saved after every runner.'),
    rule(55),
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// renderSuccessBanner
// ---------------------------------------------------------------------------

export interface SuccessBannerOptions {
  /** Flow name, e.g. "codebase-discovery". */
  flowName: string;
  /** Short run id, e.g. "f9c3a2". */
  runId: string;
  /** One entry per step, in execution order. */
  steps: SuccessStepRow[];
  /** Total wall-clock duration for the whole run. */
  totalDurationMs: number;
  /** Total cost (USD) for the run. */
  totalCostUsd: number;
  /** Auth/billing state — determines the cost row label. */
  auth: AuthState;
  /**
   * Path to the primary output artifact.
   * e.g. "./.relay/runs/f9c3a2/report.html"
   */
  outputPath: string;
}

/**
 * Produces the successful-completion banner.
 *
 * Example output:
 *
 *   ●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✓
 *
 *    ✓ inventory       sonnet     2.1s     $0.005
 *    ✓ entities        sonnet     4.8s     $0.021
 *    ...
 *
 *   all 5 steps succeeded in 11m 42s
 *
 *   cost     $0.38  (estimated api equivalent; billed to subscription)
 *   output   ./.relay/runs/f9c3a2/report.html
 *
 *   next:
 *       open the report        open ./.relay/runs/f9c3a2/report.html
 *       run again fresh        relay run codebase-discovery . --fresh
 *       share with team        relay share f9c3a2   (coming v1.1)
 */
export function renderSuccessBanner(opts: SuccessBannerOptions): string {
  const { flowName, runId, steps, totalDurationMs, totalCostUsd, auth, outputPath } = opts;

  // Header line: "●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✓"
  const header = green(flowHeader(flowName, runId, SYMBOLS.ok));

  // Per-step lines — " ✓ <name padded> <model padded> <dur padded> $cost"
  const stepLines = steps.map((s) => {
    const nameCol = s.name.padEnd(STEP_NAME_WIDTH);
    const modelCol = s.model.padEnd(MODEL_WIDTH);
    const durCol = fmtDuration(s.durationMs).padEnd(DURATION_WIDTH);
    const costCol = fmtStepCost(s.costUsd);
    return green(` ${SYMBOLS.ok} ${nameCol}${modelCol}${durCol}${costCol}`);
  });

  // Summary line: "all 5 runners succeeded in 11m 42s"
  const summary = `all ${steps.length} runners succeeded in ${fmtDuration(totalDurationMs)}`;

  // cost row label depends on billing source
  const costLabel =
    auth.billingSource === 'subscription'
      ? `${fmtTotalCost(totalCostUsd)}  (estimated api equivalent; billed to subscription)`
      : `${fmtTotalCost(totalCostUsd)}  (billed to api account)`;

  // next: block
  const nextIndent = '    ';
  const nextActionWidth = 22;
  const nextBlock = [
    'next:',
    `${nextIndent}${'open the report'.padEnd(nextActionWidth)} open ${outputPath}`,
    `${nextIndent}${'run again fresh'.padEnd(nextActionWidth)} relay run ${flowName} . --fresh`,
    `${nextIndent}${'share with team'.padEnd(nextActionWidth)} relay share ${runId}   (coming v1.1)`,
  ].join('\n');

  const lines: string[] = [
    header,
    '',
    ...stepLines,
    '',
    summary,
    '',
    kvLine('cost', costLabel),
    kvLine('output', outputPath),
    '',
    nextBlock,
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// renderFailureBanner
// ---------------------------------------------------------------------------

export interface FailureBannerOptions {
  /** Flow name, e.g. "codebase-discovery". */
  flowName: string;
  /** Short run id, e.g. "f9c3a2". */
  runId: string;
  /** All steps in execution order (succeeded + failed + pending). */
  steps: FailureStepRow[];
  /**
   * Total cost spent before the failure (USD).
   * Shown as "$X.XX spent".
   */
  spentUsd: number;
  /**
   * If the failing runner's error names a baton, provide the baton id here
   * so the banner appends a `cat` hint in the "to inspect:" block.
   */
  batonId?: string;
}

/**
 * Produces the failure banner. Lists steps with their status, shows spend
 * so far, and gives the user three explicit next actions.
 *
 * Example output:
 *
 *   ●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✕
 *
 *    ✓ inventory       sonnet     2.1s     $0.005
 *    ✓ entities        sonnet     4.8s     $0.021
 *    ✓ services        sonnet     5.1s     $0.023
 *    ✕ designReview    exit 1     0.2s
 *         branch 'entities' raised HandoffSchemaError
 *         handoff 'entities' missing required field: entities[3].language
 *
 *   3 of 5 steps succeeded · $0.049 spent · state saved
 *
 *   to resume after fixing:
 *       relay resume f9c3a2
 *
 *   to restart from scratch:
 *       relay run codebase-discovery . --fresh
 *
 *   to inspect:
 *       relay logs f9c3a2                   full structured log
 *       cat ./.relay/runs/f9c3a2/handoffs/entities.json
 */
export function renderFailureBanner(opts: FailureBannerOptions): string {
  const { flowName, runId, steps, spentUsd, batonId } = opts;

  // Header line: "●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✕"
  const header = red(flowHeader(flowName, runId, SYMBOLS.fail));

  // Per-step lines
  const stepLines: string[] = [];
  for (const s of steps) {
    const nameCol = s.name.padEnd(STEP_NAME_WIDTH);
    const durCol = fmtDuration(s.durationMs).padEnd(DURATION_WIDTH);

    if (s.status === 'succeeded') {
      const modelCol = s.model.padEnd(MODEL_WIDTH);
      const costCol = fmtStepCost(s.costUsd);
      stepLines.push(green(` ${SYMBOLS.ok} ${nameCol}${modelCol}${durCol}${costCol}`));
    } else if (s.status === 'failed') {
      // Failed step: show "exit N" in the model column, no cost column
      const exitLabel = `exit ${s.exitCode ?? 1}`;
      const modelCol = exitLabel.padEnd(MODEL_WIDTH);
      const failLine = red(` ${SYMBOLS.fail} ${nameCol}${modelCol}${durCol}`);
      stepLines.push(failLine);
      if (s.errorLines !== undefined) {
        const [line1, line2] = s.errorLines;
        stepLines.push(gray(`     ${line1}`));
        stepLines.push(gray(`     ${line2}`));
      }
    } else {
      // skipped — show with pending symbol and no cost
      const modelCol = s.model.padEnd(MODEL_WIDTH);
      stepLines.push(gray(` ${SYMBOLS.pending} ${nameCol}${modelCol}`));
    }
  }

  // Count succeeded steps
  const succeededCount = steps.filter((s) => s.status === 'succeeded').length;
  const totalCount = steps.length;

  // Summary line: "3 of 5 runners succeeded · $0.049 spent · state saved"
  const summary = `${succeededCount} of ${totalCount} runners succeeded ${SYMBOLS.dot} ${fmtTotalCost(spentUsd)} spent ${SYMBOLS.dot} state saved`;

  // "to resume after fixing:" block
  const resumeBlock = [
    'to resume after fixing:',
    `    relay resume ${runId}`,
  ].join('\n');

  // "to restart from scratch:" block
  const restartBlock = [
    'to restart from scratch:',
    `    relay run ${flowName} . --fresh`,
  ].join('\n');

  // "to inspect:" block — conditionally append the cat hint
  const logsLine = `    relay logs ${runId}`;
  const logsAnnotation = '                   full structured log';
  const inspectLines: string[] = [
    'to inspect:',
    `${logsLine}${logsAnnotation}`,
  ];
  if (batonId !== undefined) {
    inspectLines.push(`    cat ./.relay/runs/${runId}/batons/${batonId}.json`);
  }
  const inspectBlock = inspectLines.join('\n');

  const lines: string[] = [
    header,
    '',
    ...stepLines,
    '',
    summary,
    '',
    resumeBlock,
    '',
    restartBlock,
    '',
    inspectBlock,
  ];

  return lines.join('\n') + '\n';
}
