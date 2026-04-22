/**
 * Stream-json envelope translator for the claude-cli provider.
 *
 * The `claude -p` binary emits NDJSON envelopes that mostly mirror the shapes
 * the Agent SDK yields (`system`, `assistant`, `user`, `result`) plus one
 * extra wrapper not present in the SDK path: `stream_event`. The wrapper
 * carries the wire-level Messages-API streaming events (`message_start`,
 * `content_block_delta`, `content_block_stop`, `message_delta`,
 * `message_stop`) under `event`. The inner shape is snake_case identical to
 * what the SDK exposes via `content_block_delta` and turn-boundary events.
 *
 * This translator unwraps `stream_event` and delegates the inner event back
 * to the existing SDK translator, then delegates every other top-level type
 * straight to it. The result: token-by-token deltas are preserved, and the
 * SDK provider's translator remains the single source of truth for shape
 * mapping.
 *
 * The function never throws — any unrecognized or malformed message returns
 * an empty array, the same contract as `translateSdkMessage`.
 */

import { translateSdkMessage } from '../claude/translate.js';
import type { InvocationEvent } from '../types.js';

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

/**
 * Translate one raw NDJSON envelope from `claude -p` into zero or more
 * InvocationEvents. Unknown shapes return `[]`.
 *
 * Mapping:
 *   - `stream_event` → unwrap `event` and re-translate (preserves text deltas
 *     and turn boundaries from the wire-level Messages-API stream).
 *   - everything else (`system`, `assistant`, `user`, `result`,
 *     `rate_limit_event`, ...) → forward to `translateSdkMessage` unchanged.
 *
 * The CLI's `assistant` envelope carries the assembled text the deltas have
 * already streamed, and `translateSdkMessage` deliberately skips the text
 * blocks inside `assistant.content` to avoid double-counting. That suppression
 * is the right behaviour here too — the per-token deltas come through
 * `stream_event.content_block_delta` instead.
 */
export function translateCliMessage(msg: unknown): InvocationEvent[] {
  if (!isRecord(msg)) return [];
  const type = msg['type'];
  if (!isString(type)) return [];

  if (type === 'stream_event') {
    const inner = msg['event'];
    return translateSdkMessage(inner);
  }

  return translateSdkMessage(msg);
}
