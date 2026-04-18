import { readFile } from 'node:fs/promises';

import { err, ok, type Result } from 'neverthrow';

import { MetricsWriteError, StateCorruptError } from './errors.js';
import { atomicWriteJson } from './util/atomic-write.js';

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
  costUsd?: number;
  sessionId?: string;
  stopReason?: string | null;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// CostSummary — aggregate view returned by CostTracker.summary()
// ---------------------------------------------------------------------------

export interface CostSummary {
  /** Sum of all entry.costUsd values, treating absent/undefined as 0. */
  totalUsd: number;
  /** Sum of tokensIn + tokensOut across all entries. */
  totalTokens: number;
  /** Count of entries where costUsd is a finite number (including 0). */
  costKnown: number;
  /** Count of all entries, regardless of whether costUsd is present. */
  costTotal: number;
  /** Defensive copy of recorded entries. */
  perStep: StepMetrics[];
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
          cause: writeResult.error.message,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Aggregate totals across all recorded steps.
   * Missing costUsd values are treated as 0 so totalUsd never becomes NaN.
   * Pure and synchronous — reads in-memory state only.
   */
  summary(): CostSummary {
    let totalUsd = 0;
    let totalTokens = 0;

    for (const entry of this.#entries) {
      totalUsd += entry.costUsd ?? 0;
      totalTokens += entry.tokensIn + entry.tokensOut;
    }

    return {
      totalUsd,
      totalTokens,
      costKnown: this.#costKnownCount,
      costTotal: this.#entries.length,
      perStep: [...this.#entries],
    };
  }

  /**
   * Load metrics from disk, replacing the in-memory list and rebuilding the
   * costKnown counter from the loaded entries.
   *
   * ENOENT is treated as a fresh run — resets to an empty list and returns ok(undefined).
   * Other read errors return err(MetricsWriteError).
   * A file that is not valid JSON returns err(StateCorruptError).
   * A file whose top-level value is not an array returns err(StateCorruptError).
   */
  async load(): Promise<Result<void, StateCorruptError | MetricsWriteError>> {
    let raw: string;
    try {
      raw = await readFile(this.#metricsPath, { encoding: 'utf8' });
    } catch (readErr) {
      const e = readErr as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        this.#entries = [];
        this.#costKnownCount = 0;
        return ok(undefined);
      }
      const message = e instanceof Error ? e.message : String(readErr);
      return err(new MetricsWriteError(`failed to read metrics.json: ${message}`));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return err(
        new StateCorruptError(`metrics.json is malformed: ${message}`, {
          path: this.#metricsPath,
        }),
      );
    }

    if (!Array.isArray(parsed)) {
      return err(
        new StateCorruptError('metrics.json is not an array', { path: this.#metricsPath }),
      );
    }

    const entries = parsed as StepMetrics[];
    this.#entries = entries;
    this.#costKnownCount = entries.filter((e) => isCostKnown(e.costUsd)).length;
    return ok(undefined);
  }
}
