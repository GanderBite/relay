import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteJson } from './util/atomic-write.js';

// ---------------------------------------------------------------------------
// StepMetrics — one entry per completed prompt step
// ---------------------------------------------------------------------------

export type StepMetrics = {
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
   * Subscription users pay a flat rate, not per-token — so this is a ceiling
   * figure that reflects what the same usage would cost on a pay-as-you-go
   * API account. It is not an invoice amount.
   */
  costUsd: number;
  sessionId: string;
  stopReason: string | null;
  isError: boolean;
};

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  readonly #metricsPath: string;
  #entries: StepMetrics[] = [];

  constructor(runDir: string) {
    this.#metricsPath = join(runDir, 'metrics.json');
  }

  /**
   * Append a step's metrics to the in-memory list, then atomically rewrite
   * the full metrics.json array to disk.
   */
  async record(metrics: StepMetrics): Promise<void> {
    this.#entries.push(metrics);

    const writeResult = await atomicWriteJson(this.#metricsPath, this.#entries);
    if (writeResult.isErr()) {
      throw writeResult.error;
    }
  }

  /**
   * Aggregate totals across all recorded steps.
   * Returns a defensive copy of `perStep` so callers cannot mutate internal state.
   */
  summary(): { totalUsd: number; totalTokens: number; perStep: StepMetrics[] } {
    let totalUsd = 0;
    let totalTokens = 0;

    for (const entry of this.#entries) {
      totalUsd += entry.costUsd;
      totalTokens += entry.tokensIn + entry.tokensOut;
    }

    return {
      totalUsd,
      totalTokens,
      perStep: [...this.#entries],
    };
  }

  /**
   * Load metrics from disk, replacing the in-memory list.
   * Calling this multiple times does not duplicate entries.
   * Silently resolves with an empty list when metrics.json does not yet exist.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#metricsPath, { encoding: 'utf8' });
    } catch {
      this.#entries = [];
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      this.#entries = [];
      return;
    }

    this.#entries = parsed as StepMetrics[];
  }
}
