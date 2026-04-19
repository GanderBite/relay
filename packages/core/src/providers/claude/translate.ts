/**
 * SDK message translator for the Claude provider.
 *
 * Converts the raw message shapes emitted by the claude-agent-sdk query()
 * async iterator into typed InvocationEvents. The translator is the single
 * boundary where snake_case field names from the SDK become camelCase — no
 * downstream code should ever see snake_case token field names.
 *
 * Design contract: the function returns an array of zero or more events. A
 * single SDK message may produce multiple events (e.g., an assistant message
 * with several content blocks followed by a usage envelope). Events are
 * returned in source order; the usage event, when present, is always last.
 * The function is pure — no state is held across calls.
 *
 * The function never throws. Any unrecognized or malformed message shape
 * returns an empty array; the provider ignores empty arrays in the event stream.
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
// Partial NormalizedUsage extraction — handles the snake_case SDK fields
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
    // Populate toolUseId when the SDK provides the correlation id so the
    // provider's id-to-name map can match this call against its later result.
    const id = block['id'];
    const toolUseId = isString(id) ? id : undefined;
    return { type: 'tool.call', name, input, toolUseId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turn number extraction — returns 0 when the SDK omits the field.
// The provider may substitute a monotonic counter for the 0 sentinel.
// ---------------------------------------------------------------------------

function extractTurnNumber(msg: Record<string, unknown>): number {
  const turn = msg['turn'];
  if (isNumber(turn) && turn >= 1) return Math.floor(turn);
  return 0;
}

// ---------------------------------------------------------------------------
// Main translator
// ---------------------------------------------------------------------------

/**
 * Translate a single raw SDK message into zero or more InvocationEvents.
 *
 * Returns an empty array for purely informational messages that carry no
 * event data the runner needs to act on (system init messages, echoed
 * prompts, etc.). Multi-block assistant messages produce one event per
 * translatable content block; a usage event, when present, is appended last.
 *
 * Never throws — any error during translation is caught and returns [].
 */
export function translateSdkMessage(msg: unknown): InvocationEvent[] {
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

    // Standalone tool_use block (some SDK versions emit these at the top level)
    if (msgType === 'tool_use') {
      const name = msg['name'];
      if (!isString(name)) return [];
      const input = 'input' in msg ? msg['input'] : undefined;
      const id = msg['id'];
      const toolUseId = isString(id) ? id : undefined;
      return [{ type: 'tool.call', name, input, toolUseId }];
    }

    // Standalone tool_result block
    if (msgType === 'tool_result') {
      const isError = msg['is_error'];
      const ok = isError !== true;
      // The SDK references the originating call by tool_use_id, not by name.
      // The name is not available in the tool_result envelope itself, so we
      // emit 'unknown'. The provider maintains an id-to-name map and resolves
      // the real name before yielding downstream.
      const toolUseId = isString(msg['tool_use_id']) ? msg['tool_use_id'] : undefined;
      return [{ type: 'tool.result', name: 'unknown', ok, toolUseId }];
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

    // Result message — carries final usage metadata and the terminal
    // stop reason. extractSdkResultSummary still handles model/numTurns/
    // sessionId for the non-streaming invoke() path; here we emit the usage
    // event (when present) followed by a stream.end event so stream-path
    // aggregators can populate InvocationResponse.stopReason without
    // re-reading the raw payload. The provider substitutes 'stream_completed'
    // when the SDK omits stop_reason so downstream callers never see null.
    if (msgType === 'result') {
      const events: InvocationEvent[] = [];
      const usage = extractUsage(msg['usage']);
      if (usage !== null) {
        events.push({ type: 'usage', usage });
      }
      const rawStop = msg['stop_reason'];
      const stopReason =
        isString(rawStop) && rawStop.length > 0 ? rawStop : 'stream_completed';
      events.push({ type: 'stream.end', stopReason });
      return events;
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
          // Handle tool_result blocks inside assistant message content
          if (isRecord(block) && block['type'] === 'tool_result') {
            const isError = block['is_error'];
            const ok = isError !== true;
            const rawId = block['tool_use_id'];
            const toolUseId = isString(rawId) ? rawId : undefined;
            events.push({ type: 'tool.result', name: 'unknown', ok, toolUseId });
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

    // User message — look for tool_result blocks (the SDK wraps these in user turns)
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
          events.push({ type: 'tool.result', name: 'unknown', ok, toolUseId });
        }
      }

      return events;
    }

    // Top-level usage object (some SDK versions surface usage at the root)
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
// SdkResultSummary — response-level metadata from the SDK result message
// ---------------------------------------------------------------------------

/**
 * Response-level metadata captured from the SDK's final result message.
 * Fields the SDK omits are undefined — the translator never fabricates defaults.
 */
export interface SdkResultSummary {
  model: string | undefined;
  stopReason: string | null | undefined;
  numTurns: number | undefined;
  sessionId: string | undefined;
}

/**
 * Extracts response-level metadata from an SDK result message for the provider
 * to populate InvocationResponse fields (model, stopReason, numTurns, sessionId).
 */
export function extractSdkResultSummary(msg: unknown): SdkResultSummary | null {
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
export function mergeUsage(
  a: NormalizedUsage,
  b: Partial<NormalizedUsage>,
): NormalizedUsage {
  return {
    inputTokens: toSafeNumber(a.inputTokens) + toSafeNumber(b.inputTokens),
    outputTokens: toSafeNumber(a.outputTokens) + toSafeNumber(b.outputTokens),
    cacheReadTokens: toSafeNumber(a.cacheReadTokens) + toSafeNumber(b.cacheReadTokens),
    cacheCreationTokens:
      toSafeNumber(a.cacheCreationTokens) + toSafeNumber(b.cacheCreationTokens),
  };
}
