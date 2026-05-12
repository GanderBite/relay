import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';

export interface AuthInfo {
  /** Short label shown in banners, e.g. "subscription (max)" */
  label: string;
  /** Estimated cost ceiling in USD; 0 for subscription billing */
  estUsd: number;
}

export interface StepDisplayState {
  id: string;
  dependsOn: readonly string[];
  live: LiveStatePartial | null;
  runningStartedAt: string | null;
  finalDurationMs: number | null;
  finalTokensIn: number | null;
  finalTokensOut: number | null;
  finalCostUsd: number | null;
  finalModel: string | null;
  cumulativeTokens: number | null;
}

export interface VerboseAccumulator {
  lines: string[];
  streamingLineIndex: number;
  textDeltaChars: number;
  turns: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | undefined;
}

export function makeAccumulator(): VerboseAccumulator {
  return {
    lines: [],
    streamingLineIndex: 0,
    textDeltaChars: 0,
    turns: 0,
    tools: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: undefined,
  };
}
