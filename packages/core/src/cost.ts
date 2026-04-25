import { readFile } from 'node:fs/promises';

import { err, fromPromise, ok, type Result } from 'neverthrow';

import { MetricsWriteError, StateCorruptError } from './errors.js';
import { atomicWriteJson } from './util/atomic-write.js';
import { parseWithSchema } from './util/json.js';
import { z } from './zod.js';

// ---------------------------------------------------------------------------
// StepMetrics — one entry per completed prompt step
// ---------------------------------------------------------------------------

export interface StepMetrics {
  stepId: string;
  flowName: string;
  runId: string;
  /** ISO-8601 timestamp of when the step completed. */
  timestamp: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
  /**
   * API-equivalent cost estimate in USD.
   * Omitted when the provider has no reliable estimate — for example,
   * subscription-billed runs where no per-token charge applies.
   * When present, 0 is a valid and distinct value from "unknown".
   */
  costUsd?: number | undefined;
  sessionId?: string | undefined;
  stopReason?: string | null | undefined;
  isError?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Internal schemas — validate metrics.json on load, not exported
// ---------------------------------------------------------------------------

const StepMetricsSchema: z.ZodType<StepMetrics> = z.object({
  stepId: z.string(),
  flowName: z.string(),
  runId: z.string(),
  timestamp: z.string(),
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  numTurns: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  sessionId: z.string().optional(),
  stopReason: z.string().nullable().optional(),
  isError: z.boolean().optional(),
});

const StepMetricsArraySchema: z.ZodType<StepMetrics[]> = z.array(StepMetricsSchema);

// ---------------------------------------------------------------------------
// CostSummary — aggregate view returned by CostTracker.summary()
// ---------------------------------------------------------------------------

export interface CostSummary {
  /** Sum of all entry.costUsd values, treating absent/undefined as 0. */
  totalUsd: number;
  /** Sum of tokensIn + tokensOut + cacheReadTokens + cacheCreationTokens across all entries. */
  totalTokens: number;
  /** Count of entries where costUsd is a finite number (including 0). */
  costKnown: number;
  /** Count of all entries, regardless of whether costUsd is present. */
  costTotal: number;
  /** Defensive copy of recorded entries. */
  perStep: StepMetrics[];
  /**
   * Per-model aggregation keyed by the raw `StepMetrics.model` string. Each
   * entry holds the same totals as the top-level but scoped to entries that
   * named that model.
   */
  perModel: Record<
    string,
    {
      totalUsd: number;
      totalTokens: number;
      stepCount: number;
      costKnown: number;
    }
  >;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/** Returns true when the value is a finite number — 0 counts as known. */
function isCostKnown(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export class CostTracker {
  readonly #metricsPath: string;
  #entries: StepMetrics[] = [];
  #costKnownCount = 0;

  constructor(metricsPath: string) {
    this.#metricsPath = metricsPath;
  }

  /**
   * Append a step's metrics to the in-memory list, then atomically rewrite
   * the full metrics.json array to disk.
   *
   * Returns ok(undefined) on success.
   * Returns err(MetricsWriteError) when the atomic write fails.
   */
  async record(metrics: StepMetrics): Promise<Result<void, MetricsWriteError>> {
    this.#entries.push(metrics);
    if (isCostKnown(metrics.costUsd)) {
      this.#costKnownCount += 1;
    }

    const writeResult = await atomicWriteJson(this.#metricsPath, this.#entries);
    if (writeResult.isErr()) {
      return err(
        new MetricsWriteError(`failed to write metrics.json: ${writeResult.error.message}`, {
          cause: writeResult.error,
          ...(writeResult.error.errno !== undefined ? { errno: writeResult.error.errno } : {}),
          path: writeResult.error.path,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Aggregate totals across all recorded steps.
   * Missing costUsd values are treated as 0 so totalUsd never becomes NaN.
   * Pure and synchronous — reads in-memory state only.
   * Iterates entries exactly once to build both top-level and per-model totals.
   */
  summary(): CostSummary {
    let totalUsd = 0;
    let totalTokens = 0;
    const perModel: CostSummary['perModel'] = {};

    for (const entry of this.#entries) {
      const entryTokens =
        entry.tokensIn + entry.tokensOut + entry.cacheReadTokens + entry.cacheCreationTokens;
      totalUsd += entry.costUsd ?? 0;
      totalTokens += entryTokens;

      if (perModel[entry.model] === undefined) {
        perModel[entry.model] = { totalUsd: 0, totalTokens: 0, stepCount: 0, costKnown: 0 };
      }
      const bucket = perModel[entry.model]!;
      bucket.totalUsd += entry.costUsd ?? 0;
      bucket.totalTokens += entryTokens;
      bucket.stepCount += 1;
      bucket.costKnown += isCostKnown(entry.costUsd) ? 1 : 0;
    }

    return {
      totalUsd,
      totalTokens,
      costKnown: this.#costKnownCount,
      costTotal: this.#entries.length,
      perStep: [...this.#entries],
      perModel,
    };
  }

  /**
   * Load metrics from disk, replacing the in-memory list and rebuilding the
   * costKnown counter from the loaded entries.
   *
   * ENOENT is treated as a fresh run — resets to an empty list and returns ok(undefined).
   * Other read errors return err(MetricsWriteError).
   * A file whose JSON is malformed or does not match the StepMetrics array
   * shape returns err(StateCorruptError).
   */
  async load(): Promise<Result<void, StateCorruptError | MetricsWriteError>> {
    const readResult = await fromPromise(
      readFile(this.#metricsPath, { encoding: 'utf8' }),
      (e) => e as NodeJS.ErrnoException,
    );

    if (readResult.isErr()) {
      const e = readResult.error;
      if (e.code === 'ENOENT') {
        this.#entries = [];
        this.#costKnownCount = 0;
        return ok(undefined);
      }
      return err(new MetricsWriteError(`failed to read metrics.json: ${e.message ?? String(e)}`));
    }

    const parseResult = parseWithSchema(readResult.value, StepMetricsArraySchema);
    if (parseResult.isErr()) {
      return err(
        new StateCorruptError('metrics.json is malformed: ' + parseResult.error.message, {
          path: this.#metricsPath,
          cause: parseResult.error.details?.cause,
        }),
      );
    }

    const entries = parseResult.value;
    this.#entries = entries;
    this.#costKnownCount = entries.filter((e) => isCostKnown(e.costUsd)).length;
    return ok(undefined);
  }
}
