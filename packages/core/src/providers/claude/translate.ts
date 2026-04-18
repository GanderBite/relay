/**
 * SDK message translator for the Claude provider.
 *
 * Converts the raw message shapes emitted by the claude-agent-sdk query()
 * async iterator into typed InvocationEvents. The translator is the single
 * boundary where snake_case field names from the SDK become camelCase — no
 * downstream code should ever see snake_case token field names.
 *
 * Design contract: one event per call. The function returns the FIRST
 * translatable event found in the message and ignores the rest. Callers that
 * need per-content-block granularity should decompose multi-block assistant
 * messages before calling this function. This keeps the function pure and
 * side-effect-free, which simplifies testing and makes the mapping explicit.
 *
 * The function never throws. Any unrecognized or malformed message shape
 * returns null; the runner ignores nulls in the event stream.
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
    return { type: 'tool.call', name, input };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turn number extraction — defaults to 1 when not present
// ---------------------------------------------------------------------------

function extractTurnNumber(msg: Record<string, unknown>): number {
  const turn = msg['turn'];
  if (isNumber(turn) && turn >= 1) return Math.floor(turn);
  return 1;
}

// ---------------------------------------------------------------------------
// Main translator
// ---------------------------------------------------------------------------

/**
 * Translate a single raw SDK message into an InvocationEvent.
 *
 * Returns null for purely informational messages that carry no event data
 * the runner needs to act on (system init messages, echoed prompts, etc.).
 *
 * Never throws — any error during translation is caught and returns null.
 */
export function translateSdkMessage(msg: unknown): InvocationEvent | null {
  try {
    if (!isRecord(msg)) return null;

    const msgType = msg['type'];
    if (!isString(msgType)) return null;

    // System messages are purely informational — init, heartbeat, etc.
    if (msgType === 'system') {
      return null;
    }

    // Turn boundary events
    if (msgType === 'turn_start' || msgType === 'message_start') {
      return { type: 'turn.start', turn: extractTurnNumber(msg) };
    }

    if (msgType === 'turn_end' || msgType === 'message_stop') {
      return { type: 'turn.end', turn: extractTurnNumber(msg) };
    }

    // Standalone tool_use block (some SDK versions emit these at the top level)
    if (msgType === 'tool_use') {
      const name = msg['name'];
      if (!isString(name)) return null;
      const input = 'input' in msg ? msg['input'] : undefined;
      return { type: 'tool.call', name, input };
    }

    // Standalone tool_result block
    if (msgType === 'tool_result') {
      const isError = msg['is_error'];
      const ok = isError !== true;
      // The SDK references the originating call by tool_use_id, not by name.
      // The name is not available in the tool_result envelope itself, so we
      // emit 'unknown'. Callers that track the id-to-name map may post-process.
      return { type: 'tool.result', name: 'unknown', ok };
    }

    // Content-block delta (streaming token-by-token form)
    if (msgType === 'content_block_delta') {
      const delta = msg['delta'];
      if (!isRecord(delta)) return null;
      const deltaType = delta['type'];
      if (deltaType === 'text_delta') {
        const text = delta['text'];
        return isString(text) ? { type: 'text.delta', delta: text } : null;
      }
      return null;
    }

    // Result message — carries final usage metadata
    if (msgType === 'result') {
      const usage = extractUsage(msg['usage']);
      if (usage !== null) {
        return { type: 'usage', usage };
      }
      return null;
    }

    // Assistant message — walk content blocks for text and tool_use
    if (msgType === 'assistant') {
      const message = msg['message'];
      if (!isRecord(message)) return null;

      // Check for usage on the assistant message envelope
      const usageRaw = message['usage'];
      if (isRecord(usageRaw)) {
        const usage = extractUsage(usageRaw);
        if (usage !== null) {
          return { type: 'usage', usage };
        }
      }

      const content = message['content'];
      if (!isArray(content)) return null;

      // Return the first translatable event found in the content array.
      // Multi-block messages are intentionally handled one call at a time —
      // the caller drives iteration and calls translateSdkMessage per block
      // when it needs finer granularity.
      for (const block of content) {
        const event = translateContentBlock(block);
        if (event !== null) return event;
      }

      return null;
    }

    // User message — look for tool_result blocks (the SDK wraps these in user turns)
    if (msgType === 'user') {
      const message = msg['message'];
      if (!isRecord(message)) return null;

      const content = message['content'];
      if (!isArray(content)) return null;

      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block['type'] === 'tool_result') {
          const isError = block['is_error'];
          const ok = isError !== true;
          return { type: 'tool.result', name: 'unknown', ok };
        }
      }

      return null;
    }

    // Top-level usage object (some SDK versions surface usage at the root)
    const topUsage = extractUsage(msg['usage']);
    if (topUsage !== null) {
      return { type: 'usage', usage: topUsage };
    }

    // Unrecognized message — treat as informational
    return null;
  } catch {
    // Guard against any unexpected shape — the translator must never throw
    return null;
  }
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
