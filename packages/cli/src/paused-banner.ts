/**
 * Paused (Ctrl-C) banner for the Relay CLI.
 *
 * Rendered when the user presses Ctrl-C during a run or resume. The display
 * reflects that the run is paused, not failed — state is saved and the run
 * can be resumed with `relay resume <runId>`.
 *
 * Product spec §11.5 verbatim example:
 *
 *   ^C
 *
 *   ●─▶●─▶●─▶●  codebase-discovery · f9c3a2  (paused)
 *
 *    ✓ inventory       sonnet     2.1s     $0.005
 *    ✓ entities        sonnet     4.8s     $0.021
 *    ⊘ services        cancelled mid-step (turn 2)
 *    ○ designReview    not started
 *    ○ report          not started
 *
 *   state saved. $0.026 spent.
 *
 *   resume: relay resume f9c3a2
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunnerState } from '@relay/core';

import {
  MARK,
  SYMBOLS,
  STEP_NAME_WIDTH,
  MODEL_WIDTH,
  DURATION_WIDTH,
  gray,
  green,
  red,
} from './visual.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawStepState extends RunnerState {
  model?: string;
}

interface RawMetrics {
  runnerId: string;
  durationMs?: number;
  costUsd?: number;
  model?: string;
}

interface RawState {
  runners?: Record<string, RawStepState>;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) {
    const s = ms / 1000;
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function fmtStepCost(usd: number): string {
  const ceiled = Math.ceil(usd * 1000) / 1000;
  return `$${ceiled.toFixed(3)}`;
}

function fmtTotalCost(usd: number): string {
  const ceiled = Math.ceil(usd * 1000) / 1000;
  return `$${ceiled.toFixed(3)}`;
}

function stepDurationMs(stepState: RawStepState): number {
  if (
    typeof stepState.startedAt === 'string' &&
    typeof stepState.completedAt === 'string'
  ) {
    const start = Date.parse(stepState.startedAt);
    const end = Date.parse(stepState.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Step row renderer
// ---------------------------------------------------------------------------

function renderPausedRunnerRow(
  runnerId: string,
  stepState: RawStepState,
  metric: RawMetrics | undefined,
): string {
  const nameCol = runnerId.padEnd(STEP_NAME_WIDTH);

  if (stepState.status === 'succeeded') {
    const durationMs = metric?.durationMs ?? stepDurationMs(stepState);
    const model = (metric?.model ?? stepState.model ?? 'sonnet').padEnd(MODEL_WIDTH);
    const durStr = fmtDuration(durationMs).padEnd(DURATION_WIDTH);
    const costUsd = metric?.costUsd ?? 0;
    const costStr = fmtStepCost(costUsd);
    return green(` ${SYMBOLS.ok} ${nameCol}${model}${durStr}${costStr}`);
  }

  if (stepState.status === 'failed') {
    const durationMs = metric?.durationMs ?? stepDurationMs(stepState);
    const model = (metric?.model ?? stepState.model ?? 'sonnet').padEnd(MODEL_WIDTH);
    const durStr = fmtDuration(durationMs).padEnd(DURATION_WIDTH);
    const costUsd = metric?.costUsd ?? 0;
    const costStr = fmtStepCost(costUsd);
    return red(` ${SYMBOLS.fail} ${nameCol}${model}${durStr}${costStr}`);
  }

  if (stepState.status === 'running') {
    // Mid-flight when abort fired — show as cancelled.
    const annotation = stepState.attempts > 0
      ? `cancelled mid-step (turn ${stepState.attempts})`
      : 'cancelled mid-step';
    return gray(` ${SYMBOLS.cancelled} ${nameCol}${annotation}`);
  }

  // pending / skipped — not started
  return gray(` ${SYMBOLS.pending} ${nameCol}not started`);
}

// ---------------------------------------------------------------------------
// State / metrics readers
// ---------------------------------------------------------------------------

async function readStateSteps(runDir: string): Promise<Record<string, RawStepState>> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as RawState;
    return parsed.runners ?? {};
  } catch {
    return {};
  }
}

async function readMetrics(runDir: string): Promise<Map<string, RawMetrics>> {
  const map = new Map<string, RawMetrics>();
  try {
    const raw = await readFile(join(runDir, 'metrics.json'), 'utf8');
    const entries = JSON.parse(raw) as RawMetrics[];
    for (const entry of entries) {
      if (typeof entry.runnerId === 'string') {
        map.set(entry.runnerId, entry);
      }
    }
  } catch {
    // metrics.json may not exist — fall back to zeros.
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public: renderPausedBanner
// ---------------------------------------------------------------------------

/**
 * Render and write the paused banner to stdout.
 *
 * Reads state.json and metrics.json from runDir to show per-step status.
 * Falls back to a minimal banner if state cannot be loaded.
 */
export async function renderPausedBanner(
  raceName: string,
  runId: string,
  runDir: string,
  stepOrder: readonly string[],
): Promise<void> {
  // Header: "^C" echo, blank, then the paused header line.
  process.stdout.write('^C\n');
  process.stdout.write('\n');
  process.stdout.write(`${MARK}  ${raceName} ${SYMBOLS.dot} ${runId}  (paused)\n`);
  process.stdout.write('\n');

  // Read state and metrics; on failure render minimal fallback.
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  if (Object.keys(stateSteps).length === 0 && stepOrder.length > 0) {
    // Minimal fallback: state could not be loaded.
    process.stdout.write('state saved.\n');
    process.stdout.write('\n');
    process.stdout.write(`resume: relay resume ${runId}\n`);
    return;
  }

  // Runner grid.
  for (const runnerId of stepOrder) {
    const stepState = stateSteps[runnerId];
    if (stepState === undefined) continue;
    const metric = metrics.get(runnerId);
    const row = renderPausedRunnerRow(runnerId, stepState, metric);
    process.stdout.write(row + '\n');
  }

  process.stdout.write('\n');

  // Total spent from metrics.
  let totalSpent = 0;
  for (const [, m] of metrics) {
    totalSpent += m.costUsd ?? 0;
  }

  process.stdout.write(`state saved. ${fmtTotalCost(totalSpent)} spent.\n`);
  process.stdout.write('\n');
  process.stdout.write(`resume: relay resume ${runId}\n`);
}
