/**
 * Shared Zod schemas for CLI file-reading operations.
 *
 * These schemas parse the partial shapes that the CLI needs from on-disk
 * files (state.json, metrics.json, live/<step>.json). They are intentionally
 * narrower than the full schemas in relay-core — they only validate the fields
 * the CLI actually reads so that future additions to the core types do not
 * require CLI changes.
 */

import { z } from '@ganderbite/relay-core';

// ---------------------------------------------------------------------------
// Step state — partial view of a state.json step entry
// ---------------------------------------------------------------------------

export const RawStepStateSchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  attempts: z.number().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  handoffs: z.array(z.string()).optional(),
});

export type RawStepState = z.infer<typeof RawStepStateSchema>;

// ---------------------------------------------------------------------------
// Metrics — partial view of a metrics.json entry
// ---------------------------------------------------------------------------

export const RawMetricsSchema = z.object({
  stepId: z.string(),
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
});

export type RawMetrics = z.infer<typeof RawMetricsSchema>;

// ---------------------------------------------------------------------------
// Live state — partial view of a live/<step>.json file
// ---------------------------------------------------------------------------

export const LiveStatePartialSchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  attempt: z.number(),
  startedAt: z.string(),
  lastUpdateAt: z.string(),
  model: z.string().optional(),
  tokensSoFar: z.number().optional(),
  toolsSoFar: z.number().optional(),
});
