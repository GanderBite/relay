/**
 * Per-step data helpers shared by the run and resume commands.
 *
 * Reads state.json and metrics.json from a runDir and assembles the row
 * shapes expected by renderSuccessBanner / renderFailureBanner.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@ganderbite/relay-core';
import type { FailureStepRow, SuccessStepRow } from './banner.js';
import {
  type RawMetrics,
  RawMetricsSchema,
  type RawStepState,
  RawStepStateSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Internal schemas
// ---------------------------------------------------------------------------

const RawStateJsonSchema = z.object({
  steps: z.record(z.string(), RawStepStateSchema).optional(),
});

const RawMetricsArraySchema = z.array(RawMetricsSchema);

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse state.json from runDir. Returns an empty record on any
 * failure — a missing or malformed state.json is not fatal for the banner.
 */
export async function readStateSteps(runDir: string): Promise<Record<string, RawStepState>> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8');
    const result = RawStateJsonSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data.steps ?? {}) : {};
  } catch {
    return {};
  }
}

/**
 * Read and parse metrics.json from runDir. Returns an empty Map on any
 * failure — metrics.json may not exist for very short or failed runs.
 */
export async function readMetrics(runDir: string): Promise<Map<string, RawMetrics>> {
  const map = new Map<string, RawMetrics>();
  try {
    const raw = await readFile(join(runDir, 'metrics.json'), 'utf8');
    const parseResult = RawMetricsArraySchema.safeParse(JSON.parse(raw));
    const entries = parseResult.success ? parseResult.data : [];
    for (const entry of entries) {
      if (typeof entry.stepId === 'string') {
        map.set(entry.stepId, entry as unknown as RawMetrics);
      }
    }
  } catch {
    // metrics.json may not exist for very short runs — fall back to zeros.
  }
  return map;
}

// ---------------------------------------------------------------------------
// Duration helper
// ---------------------------------------------------------------------------

function stepDurationMs(stepState: RawStepState): number {
  if (typeof stepState.startedAt === 'string' && typeof stepState.completedAt === 'string') {
    const start = Date.parse(stepState.startedAt);
    const end = Date.parse(stepState.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * Build the SuccessStepRow array for the success banner.
 *
 * Falls back to state.json timestamps when metrics.json has no durationMs
 * for a step. CostUsd and model default to 0 / 'sonnet' when absent.
 */
export async function buildSuccessStepRows(
  runDir: string,
  stepOrder: string[],
): Promise<SuccessStepRow[]> {
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  return stepOrder.map((runnerId): SuccessStepRow => {
    const stepState = stateSteps[runnerId];
    const metric = metrics.get(runnerId);
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;
    return { name: runnerId, model, durationMs, costUsd };
  });
}

/**
 * Build the FailureStepRow array for the failure banner.
 *
 * Maps each step to succeeded / failed / skipped. Error messages are
 * truncated to 80 characters to fit within the banner column width.
 */
export async function buildFailureStepRows(
  runDir: string,
  stepOrder: string[],
): Promise<FailureStepRow[]> {
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  return stepOrder.map((runnerId): FailureStepRow => {
    const stepState = stateSteps[runnerId];
    const metric = metrics.get(runnerId);
    const status = stepState?.status;
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;

    if (status === 'succeeded') {
      return { name: runnerId, status: 'succeeded', model, durationMs, costUsd };
    }
    if (status === 'failed') {
      const errorMsg = stepState?.errorMessage;
      const errorLines: [string, string] | undefined =
        errorMsg !== undefined ? [errorMsg.slice(0, 80), ''] : undefined;
      return {
        name: runnerId,
        status: 'failed',
        model,
        durationMs,
        costUsd,
        exitCode: 1,
        ...(errorLines !== undefined ? { errorLines } : {}),
      };
    }
    // pending / running / skipped / undefined — treat as skipped in the banner
    return { name: runnerId, status: 'skipped', model, durationMs, costUsd };
  });
}
