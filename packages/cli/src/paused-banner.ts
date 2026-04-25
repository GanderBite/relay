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

import type { StepState, StepStatus } from '@relay/core';
import { z } from '@relay/core';
import { MARK, SYMBOLS } from './brand.js';
import { gray, green, red } from './color.js';
import { fmtCost, fmtDuration } from './format.js';
import { DURATION_WIDTH, MODEL_WIDTH, STEP_NAME_WIDTH } from './layout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawStepState extends StepState {
  model?: string;
}

interface RawMetrics {
  stepId: string;
  durationMs?: number;
  costUsd?: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// Zod validation schemas
// ---------------------------------------------------------------------------

const STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const satisfies readonly StepStatus[];

const RawStepStateSchema = z
  .object({
    status: z.enum(STEP_STATUSES),
    attempts: z.number().default(0),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

const RawStateSchema = z
  .object({
    steps: z.record(z.string(), RawStepStateSchema).optional(),
  })
  .passthrough();

const RawMetricsEntrySchema = z.object({
  stepId: z.string(),
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
});

const RawMetricsArraySchema = z.array(RawMetricsEntrySchema);

function stepDurationMs(stepState: RawStepState): number {
  if (typeof stepState.startedAt === 'string' && typeof stepState.completedAt === 'string') {
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
    const costStr = fmtCost(costUsd);
    return green(` ${SYMBOLS.ok} ${nameCol}${model}${durStr}${costStr}`);
  }

  if (stepState.status === 'failed') {
    const durationMs = metric?.durationMs ?? stepDurationMs(stepState);
    const model = (metric?.model ?? stepState.model ?? 'sonnet').padEnd(MODEL_WIDTH);
    const durStr = fmtDuration(durationMs).padEnd(DURATION_WIDTH);
    const costUsd = metric?.costUsd ?? 0;
    const costStr = fmtCost(costUsd);
    return red(` ${SYMBOLS.fail} ${nameCol}${model}${durStr}${costStr}`);
  }

  if (stepState.status === 'running') {
    // Mid-flight when abort fired — show as cancelled.
    const annotation =
      stepState.attempts > 0
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
    const result = RawStateSchema.safeParse(JSON.parse(raw));
    if (!result.success) return {};
    return result.data.steps ?? {};
  } catch {
    return {};
  }
}

async function readMetrics(runDir: string): Promise<Map<string, RawMetrics>> {
  const map = new Map<string, RawMetrics>();
  try {
    const raw = await readFile(join(runDir, 'metrics.json'), 'utf8');
    const result = RawMetricsArraySchema.safeParse(JSON.parse(raw));
    if (!result.success) return map;
    const entries = result.data;
    for (const entry of entries) {
      map.set(entry.stepId, entry);
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
  flowName: string,
  runId: string,
  runDir: string,
  stepOrder: readonly string[],
): Promise<void> {
  // Header: "^C" echo, blank, then the paused header line.
  process.stdout.write('^C\n');
  process.stdout.write('\n');
  process.stdout.write(`${MARK}  ${flowName} ${SYMBOLS.dot} ${runId}  (paused)\n`);
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
    process.stdout.write(`${row}\n`);
  }

  process.stdout.write('\n');

  // Total spent from metrics.
  let totalSpent = 0;
  for (const [, m] of metrics) {
    totalSpent += m.costUsd ?? 0;
  }

  process.stdout.write(`state saved. ${fmtCost(totalSpent)} spent.\n`);
  process.stdout.write('\n');
  process.stdout.write(`resume: relay resume ${runId}\n`);
}
