import type { NormalizedUsage } from '../providers/types.js';

function toSafeNumber(x: unknown): number {
  return typeof x === 'number' && !Number.isNaN(x) ? x : 0;
}

/**
 * Merge two usage objects by summing each field.
 *
 * Fields missing from `b` contribute 0. The result is always a fully
 * populated NormalizedUsage with no NaN or undefined values. Use this to
 * accumulate usage across multiple partial usage events in a multi-turn run.
 */
export function mergeUsage(a: NormalizedUsage, b: Partial<NormalizedUsage>): NormalizedUsage {
  return {
    inputTokens: toSafeNumber(a.inputTokens) + toSafeNumber(b.inputTokens),
    outputTokens: toSafeNumber(a.outputTokens) + toSafeNumber(b.outputTokens),
    cacheReadTokens: toSafeNumber(a.cacheReadTokens) + toSafeNumber(b.cacheReadTokens),
    cacheCreationTokens: toSafeNumber(a.cacheCreationTokens) + toSafeNumber(b.cacheCreationTokens),
  };
}
