/**
 * Stream-json envelope translator for the claude-cli provider.
 *
 * The `claude -p` binary emits NDJSON envelopes with stable snake_case shapes:
 * `system`, `assistant`, `user`, `result`, plus a `stream_event` wrapper that
 * carries the wire-level Messages-API streaming events (`message_start`,
 * `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`)
 * under `event`. All shapes are defined by the binary's stream-json contract
 * and are stable regardless of any SDK; the translator works on `unknown` and
 * narrows with type guards so no external type imports are required.
 *
 * Design contract: each translator function returns an array of zero or more
 * events. A single envelope may produce multiple events (e.g., an assistant
 * message with several content blocks followed by a usage envelope). Events
 * are returned in source order; the usage event, when present, is always last.
 * The functions are pure — no state is held across calls.
 *
 * Translators never throw. Any unrecognized or malformed shape returns an
 * empty array; the provider ignores empty arrays in the event stream.
 */

import type { InvocationEvent, NormalizedUsage } from '../types.js';

// ---------------------------------------------------------------------------
// Type guard helpers — safe narrowing of unknown without any or as
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && !Number.isNaN(x);
}

function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

function toSafeNumber(x: unknown): number {
  if (isNumber(x)) return x;
  return 0;
}

// ---------------------------------------------------------------------------
// Partial NormalizedUsage extraction — handles the snake_case wire fields
// ---------------------------------------------------------------------------

function extractUsage(raw: unknown): Partial<NormalizedUsage> | null {
  if (!isRecord(raw)) return null;

  const hasAny =
    'input_tokens' in raw ||
    'output_tokens' in raw ||
    'cache_read_input_tokens' in raw ||
    'cache_creation_input_tokens' in raw;

  if (!hasAny) return null;

  return {
    inputTokens: toSafeNumber(raw['input_tokens']),
    outputTokens: toSafeNumber(raw['output_tokens']),
    cacheReadTokens: toSafeNumber(raw['cache_read_input_tokens']),
    cacheCreationTokens: toSafeNumber(raw['cache_creation_input_tokens']),
  };
}

// ---------------------------------------------------------------------------
// Content block translation — walks a single block from an assistant message
// ---------------------------------------------------------------------------

function translateContentBlock(block: unknown): InvocationEvent | null {
  if (!isRecord(block)) return null;

  const blockType = block['type'];

  if (blockType === 'text') {
    const text = block['text'];
    if (isString(text) && text.length > 0) {
      return { type: 'text.delta', delta: text };
    }
    return null;
  }

  if (blockType === 'tool_use') {
    const name = block['name'];
    if (!isString(name)) return null;
    // input may be absent or any shape — pass through as-is
    const input = 'input' in block ? block['input'] : undefined;
    // Populate toolUseId when the wire envelope provides the correlation id
    // so the provider's id-to-name map can match this call against its later
    // result.
    const id = block['id'];
    const toolUseId = isString(id) ? id : undefined;
    return {
      type: 'tool.call' as const,
      name,
      ...(input !== undefined ? { input } : {}),
      ...(toolUseId !== undefined ? { toolUseId } : {}),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turn number extraction — returns 0 when the envelope omits the field.
// The provider may substitute a monotonic counter for the 0 sentinel.
// ---------------------------------------------------------------------------

function extractTurnNumber(msg: Record<string, unknown>): number {
  const turn = msg['turn'];
  if (isNumber(turn) && turn >= 1) return Math.floor(turn);
  return 0;
}

// ---------------------------------------------------------------------------
// Core translator — walks a single raw stream-json envelope
// ---------------------------------------------------------------------------

/**
 * Translate one stream-json envelope (either a top-level message or the inner
 * `event` payload from a `stream_event` wrapper) into zero or more
 * InvocationEvents. Unknown shapes return `[]`. Never throws.
 */
function translateCore(msg: unknown): InvocationEvent[] {
  try {
    if (!isRecord(msg)) return [];

    const msgType = msg['type'];
    if (!isString(msgType)) return [];

    // System messages are purely informational — init, heartbeat, etc.
    if (msgType === 'system') {
      return [];
    }

    // Turn boundary events
    if (msgType === 'turn_start' || msgType === 'message_start') {
      return [{ type: 'turn.start', turn: extractTurnNumber(msg) }];
    }

    if (msgType === 'turn_end' || msgType === 'message_stop') {
      return [{ type: 'turn.end', turn: extractTurnNumber(msg) }];
    }

    // Standalone tool_use block (some envelopes surface these at the top level)
    if (msgType === 'tool_use') {
      const name = msg['name'];
      if (!isString(name)) return [];
      const input = 'input' in msg ? msg['input'] : undefined;
      const id = msg['id'];
      const toolUseId = isString(id) ? id : undefined;
      return [
        {
          type: 'tool.call' as const,
          name,
          ...(input !== undefined ? { input } : {}),
          ...(toolUseId !== undefined ? { toolUseId } : {}),
        },
      ];
    }

    // Standalone tool_result block
    if (msgType === 'tool_result') {
      const isError = msg['is_error'];
      const ok = isError !== true;
      // The wire envelope references the originating call by tool_use_id,
      // not by name. The name is not available in the tool_result envelope
      // itself, so we emit 'unknown'. The provider maintains an id-to-name
      // map and resolves the real name before yielding downstream.
      const toolUseId = isString(msg['tool_use_id']) ? msg['tool_use_id'] : undefined;
      return [
        {
          type: 'tool.result' as const,
          name: 'unknown',
          ok,
          ...(toolUseId !== undefined ? { toolUseId } : {}),
        },
      ];
    }

    // Content-block delta (streaming token-by-token form)
    if (msgType === 'content_block_delta') {
      const delta = msg['delta'];
      if (!isRecord(delta)) return [];
      const deltaType = delta['type'];
      if (deltaType === 'text_delta') {
        const text = delta['text'];
        return isString(text) ? [{ type: 'text.delta', delta: text }] : [];
      }
      return [];
    }

    // Result message — carries final usage metadata and the terminal stop
    // reason. extractResultSummary still handles model/numTurns/sessionId for
    // the non-streaming invoke() path; here we emit the usage event (when
    // present) followed by a stream.end event so stream-path aggregators can
    // populate InvocationResponse.stopReason without re-reading the raw
    // payload. The provider substitutes 'stream_completed' when stop_reason
    // is omitted so downstream callers never see null. costUsd and sessionId
    // ride along on stream.end when the envelope carries them.
    if (msgType === 'result') {
      const events: InvocationEvent[] = [];
      const usage = extractUsage(msg['usage']);
      if (usage !== null) {
        events.push({ type: 'usage', usage });
      }
      const rawStop = msg['stop_reason'];
      const stopReason = isString(rawStop) && rawStop.length > 0 ? rawStop : 'stream_completed';
      const streamEnd: Extract<InvocationEvent, { type: 'stream.end' }> = {
        type: 'stream.end',
        stopReason,
      };
      const rawCost = msg['total_cost_usd'];
      if (typeof rawCost === 'number' && Number.isFinite(rawCost)) {
        streamEnd.costUsd = rawCost;
      }
      const rawSid = msg['session_id'];
      if (isString(rawSid)) {
        streamEnd.sessionId = rawSid;
      }
      events.push(streamEnd);
      return events;
    }

    // message_delta — wire-level Messages-API streaming envelope that carries
    // a usage delta in its own `usage` field (not under `message.usage`).
    // Handle explicitly so the usage update is not dependent on the
    // fall-through top-level usage probe at the bottom of this function.
    if (msgType === 'message_delta') {
      const usage = extractUsage(msg['usage']);
      return usage !== null ? [{ type: 'usage', usage }] : [];
    }

    // Assistant message — walk ALL content blocks and collect events.
    // If the message also carries usage, append the usage event last.
    if (msgType === 'assistant') {
      const message = msg['message'];
      if (!isRecord(message)) return [];

      const events: InvocationEvent[] = [];

      const content = message['content'];
      if (isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          // Text in the final assistant summary is redundant — the same text
          // already streamed via content_block_delta events. Skip to avoid
          // double-accumulation in invoke() and stream-path aggregators.
          if (block['type'] === 'text') continue;
          if (block['type'] === 'tool_result') {
            const isError = block['is_error'];
            const ok = isError !== true;
            const rawId = block['tool_use_id'];
            const toolUseId = isString(rawId) ? rawId : undefined;
            events.push({
              type: 'tool.result',
              name: 'unknown',
              ok,
              ...(toolUseId !== undefined ? { toolUseId } : {}),
            });
            continue;
          }
          const event = translateContentBlock(block);
          if (event !== null) {
            events.push(event);
          }
        }
      }

      // Append usage last, if the assistant message envelope carries it.
      const usageRaw = message['usage'];
      if (isRecord(usageRaw)) {
        const usage = extractUsage(usageRaw);
        if (usage !== null) {
          events.push({ type: 'usage', usage });
        }
      }

      return events;
    }

    // User message — look for tool_result blocks (wire envelopes wrap these
    // in user turns).
    if (msgType === 'user') {
      const message = msg['message'];
      if (!isRecord(message)) return [];

      const content = message['content'];
      if (!isArray(content)) return [];

      const events: InvocationEvent[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block['type'] === 'tool_result') {
          const isError = block['is_error'];
          const ok = isError !== true;
          const rawId = block['tool_use_id'];
          const toolUseId = isString(rawId) ? rawId : undefined;
          events.push({
            type: 'tool.result',
            name: 'unknown',
            ok,
            ...(toolUseId !== undefined ? { toolUseId } : {}),
          });
        }
      }

      return events;
    }

    // Top-level usage object (some envelopes surface usage at the root)
    const topUsage = extractUsage(msg['usage']);
    if (topUsage !== null) {
      return [{ type: 'usage', usage: topUsage }];
    }

    // Unrecognized message — treat as informational
    return [];
  } catch {
    // Guard against any unexpected shape — the translator must never throw
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public entry point — unwraps the `stream_event` wrapper then delegates.
// ---------------------------------------------------------------------------

/**
 * Translate one raw NDJSON envelope from `claude -p` into zero or more
 * InvocationEvents. Unknown shapes return `[]`.
 *
 * Mapping:
 *   - `stream_event` → unwrap `event` and re-translate (preserves text deltas
 *     and turn boundaries from the wire-level Messages-API stream).
 *   - everything else (`system`, `assistant`, `user`, `result`, ...) →
 *     translated directly.
 *
 * The CLI's `assistant` envelope carries the assembled text the deltas have
 * already streamed, and the translator deliberately skips the text blocks
 * inside `assistant.content` to avoid double-counting. The per-token deltas
 * come through `stream_event.content_block_delta` instead.
 */
export function translateCliMessage(msg: unknown): InvocationEvent[] {
  if (!isRecord(msg)) return [];
  const type = msg['type'];
  if (!isString(type)) return [];

  if (type === 'stream_event') {
    const inner = msg['event'];
    return translateCore(inner);
  }

  return translateCore(msg);
}

// ---------------------------------------------------------------------------
// ResultSummary — response-level metadata from the final result envelope
// ---------------------------------------------------------------------------

/**
 * Response-level metadata captured from the CLI's final `result` envelope.
 * Fields the wire envelope omits are undefined — the extractor never
 * fabricates defaults.
 */
export interface ResultSummary {
  model: string | undefined;
  stopReason: string | null | undefined;
  numTurns: number | undefined;
  sessionId: string | undefined;
}

/**
 * Extracts response-level metadata from a `result` envelope for the provider
 * to populate InvocationResponse fields (model, stopReason, numTurns, sessionId).
 */
export function extractResultSummary(msg: unknown): ResultSummary | null {
  if (!isRecord(msg)) return null;
  if (msg['type'] !== 'result') return null;

  // model: prefer top-level, fall back to msg.result.model if present
  let model: string | undefined;
  if (isString(msg['model'])) {
    model = msg['model'];
  } else if (isRecord(msg['result']) && isString(msg['result']['model'])) {
    model = msg['result']['model'];
  }

  // stop_reason → stopReason (camelCase on the way out)
  const rawStopReason = msg['stop_reason'];
  let stopReason: string | null | undefined;
  if (rawStopReason === null) {
    stopReason = null;
  } else if (isString(rawStopReason)) {
    stopReason = rawStopReason;
  } else {
    stopReason = undefined;
  }

  // num_turns → numTurns
  const rawNumTurns = msg['num_turns'];
  const numTurns = isNumber(rawNumTurns) ? rawNumTurns : undefined;

  // session_id → sessionId
  const rawSessionId = msg['session_id'];
  const sessionId = isString(rawSessionId) ? rawSessionId : undefined;

  return { model, stopReason, numTurns, sessionId };
}

// ---------------------------------------------------------------------------
// mergeUsage
// ---------------------------------------------------------------------------

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
