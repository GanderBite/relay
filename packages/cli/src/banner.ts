/**
 * Pre-run, success, and failure banners for the Relay CLI.
 *
 * All brand constants (MARK, WORDMARK, SYMBOLS) and color helpers are
 * imported from visual.ts — never defined here.
 *
 * Output shapes match product spec §6.3 (start), §6.5 (success), §6.6
 * (failure) verbatim. Do not alter copy, spacing, or column widths without
 * updating the spec first.
 */

import type { AuthState, CostEstimate } from '@relay/core';
import { WORDMARK, SYMBOLS, gray, green, red, rule, kvLine } from './visual.js';

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
 * Formats a cost in USD to 4 decimal places: "$0.0050".
 */
function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * Formats an ISO date-time string to "YYYY-MM-DD HH:mm" local time.
 * Falls back to a direct slice of the ISO string (UTC) when Date is unavailable.
 */
function fmtIsoToLocal(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

// Step name column width used in §6.5 / §6.6 step lines.
// "designReview" is the longest name in the spec examples (12 chars).
// We pad to 14 so the model column aligns after a space.
const STEP_NAME_WIDTH = 14;

// Model column width ("sonnet" = 6, "-" = 1, pad to 10).
const MODEL_WIDTH = 10;

// Duration column width ("11m 42s" = 7, pad to 8).
const DURATION_WIDTH = 8;

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
   * Only present on the failed step. The first line names the error class
   * and branch; the second names the specific field or handoff.
   * Spec §6.6 example:
   *   "branch 'entities' raised HandoffSchemaError"
   *   "handoff 'entities' missing required field: entities[3].language"
   */
  errorLines?: [string, string];
}

// ---------------------------------------------------------------------------
// §6.3 — renderStartBanner
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
 * Produces the pre-run banner (product spec §6.3).
 *
 * Example output:
 *
 *   ●─▶●─▶●─▶●  relay
 *
 *   flow     codebase-discovery v0.1.0
 *   input    .  (audience=both)
 *   run      f9c3a2  ·  2026-04-17 14:32
 *   bill     subscription (max)  ·  no api charges
 *   est      $0.40  ·  5 steps  ·  ~12 min
 *
 *   press ctrl-c any time — state is saved after every step.
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

  // flow row
  const flowValue = `${flowName} v${flowVersion}`;

  // input row — "primary  (key=val, key=val)" or just "primary"
  const extras =
    inputExtras !== undefined && inputExtras.length > 0
      ? `  (${inputExtras.join(', ')})`
      : '';
  const inputValue = `${inputPrimary}${extras}`;

  // run row — "<runId>  ·  YYYY-MM-DD HH:mm"
  const runValue = `${runId}  ${SYMBOLS.dot}  ${fmtIsoToLocal(startedAt)}`;

  // bill row — NEVER silent
  // subscription → "subscription (max)  ·  no api charges"
  // api-account (and anything else) → "api account  ·  billing applies"
  const billValue =
    auth.billingSource === 'subscription'
      ? `subscription (max)  ${SYMBOLS.dot}  no api charges`
      : `api account  ${SYMBOLS.dot}  billing applies`;

  // est row — "$X.XXXX  ·  N steps  ·  ~M min"
  const costStr =
    costEstimate !== undefined ? fmtCost(costEstimate.maxUsd) : '$?.????';
  const estValue = `${costStr}  ${SYMBOLS.dot}  ${stepCount} steps  ${SYMBOLS.dot}  ~${etaMin} min`;

  const lines: string[] = [
    WORDMARK,
    '',
    kvLine('flow', flowValue),
    kvLine('input', inputValue),
    kvLine('run', runValue),
    kvLine('bill', billValue),
    kvLine('est', estValue),
    '',
    gray('press ctrl-c any time — state is saved after every step.'),
    rule(55),
  ];

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// §6.5 — renderSuccessBanner
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
 * Produces the successful-completion banner (product spec §6.5).
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
  const header = green(`${WORDMARK.replace('relay', `${flowName} ${SYMBOLS.dot} ${runId}`)}  ${SYMBOLS.ok}`);

  // Per-step lines — " ✓ <name padded> <model padded> <dur padded> $cost"
  const stepLines = steps.map((s) => {
    const nameCol = s.name.padEnd(STEP_NAME_WIDTH);
    const modelCol = s.model.padEnd(MODEL_WIDTH);
    const durCol = fmtDuration(s.durationMs).padEnd(DURATION_WIDTH);
    const costCol = fmtCost(s.costUsd);
    return green(` ${SYMBOLS.ok} ${nameCol}${modelCol}${durCol}${costCol}`);
  });

  // Summary line: "all 5 steps succeeded in 11m 42s"
  const summary = `all ${steps.length} steps succeeded in ${fmtDuration(totalDurationMs)}`;

  // cost row label depends on billing source
  const costLabel =
    auth.billingSource === 'subscription'
      ? `${fmtCost(totalCostUsd)}  (estimated api equivalent; billed to subscription)`
      : `${fmtCost(totalCostUsd)}  (billed to api account)`;

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
// §6.6 — renderFailureBanner
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
   * Shown as "$X.XXXX spent".
   */
  spentUsd: number;
  /**
   * If the failing step's error names a handoff, provide the handoff id here
   * so the banner appends a `cat` hint in the "to inspect:" block.
   */
  handoffId?: string;
}

/**
 * Produces the failure banner (product spec §6.6).
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
  const { flowName, runId, steps, spentUsd, handoffId } = opts;

  // Header line: "●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✕"
  const header = red(`${WORDMARK.replace('relay', `${flowName} ${SYMBOLS.dot} ${runId}`)}  ${SYMBOLS.fail}`);

  // Per-step lines
  const stepLines: string[] = [];
  for (const s of steps) {
    const nameCol = s.name.padEnd(STEP_NAME_WIDTH);
    const modelCol = s.model.padEnd(MODEL_WIDTH);
    const durCol = fmtDuration(s.durationMs).padEnd(DURATION_WIDTH);

    if (s.status === 'succeeded') {
      const costCol = fmtCost(s.costUsd);
      stepLines.push(green(` ${SYMBOLS.ok} ${nameCol}${modelCol}${durCol}${costCol}`));
    } else if (s.status === 'failed') {
      // Failed step: no cost column, plus optional two-line error expansion
      const failLine = red(` ${SYMBOLS.fail} ${nameCol}${modelCol}${durCol}`);
      stepLines.push(failLine);
      if (s.errorLines !== undefined) {
        const [line1, line2] = s.errorLines;
        stepLines.push(gray(`     ${line1}`));
        stepLines.push(gray(`     ${line2}`));
      }
    } else {
      // skipped — show with pending symbol and no cost
      stepLines.push(gray(` ${SYMBOLS.pending} ${nameCol}${modelCol}`));
    }
  }

  // Count succeeded steps
  const succeededCount = steps.filter((s) => s.status === 'succeeded').length;
  const totalCount = steps.length;

  // Summary line: "3 of 5 steps succeeded · $0.049 spent · state saved"
  const summary = `${succeededCount} of ${totalCount} steps succeeded ${SYMBOLS.dot} ${fmtCost(spentUsd)} spent ${SYMBOLS.dot} state saved`;

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
  if (handoffId !== undefined) {
    inspectLines.push(`    cat ./.relay/runs/${runId}/handoffs/${handoffId}.json`);
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
