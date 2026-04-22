import { describe, expect, it } from 'vitest';
import {
  extractResultSummary,
  mergeUsage,
  translateCliMessage,
} from '../../../src/providers/claude-cli/translate.js';
import type { NormalizedUsage } from '../../../src/providers/types.js';

function zeroUsage(): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

describe('translateCliMessage', () => {
  // ---------------------------------------------------------------------------
  // Basic shapes — assistant / user / result envelopes
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-001] assistant text blocks are skipped; tool_use blocks yield tool.call', () => {
    const textOnly = translateCliMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(textOnly).toHaveLength(0);

    const withTool = translateCliMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'x.ts' } }],
      },
    });
    expect(withTool).toHaveLength(1);
    expect(withTool[0]).toMatchObject({
      type: 'tool.call',
      name: 'Read',
      input: { path: 'x.ts' },
      toolUseId: 'toolu_01',
    });
  });

  it('[TRANSLATE-002] assistant tool_use block yields tool.call with name + input + toolUseId', () => {
    const events = translateCliMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'x.ts' } }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool.call',
      name: 'Read',
      input: { path: 'x.ts' },
      toolUseId: 'toolu_01',
    });
  });

  it('[TRANSLATE-003] user tool_result maps is_error to ok flag', () => {
    const okEvents = translateCliMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: 'ok' }],
      },
    });
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0]).toMatchObject({
      type: 'tool.result',
      ok: true,
      toolUseId: 'toolu_01',
      name: 'unknown',
    });

    const errEvents = translateCliMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: true }],
      },
    });
    expect(errEvents[0]).toMatchObject({ type: 'tool.result', ok: false });
  });

  it('[TRANSLATE-004] partial usage events aggregate via mergeUsage', () => {
    const e1 = translateCliMessage({
      type: 'result',
      usage: { input_tokens: 100 },
    });
    const e2 = translateCliMessage({
      type: 'result',
      usage: { output_tokens: 50, cache_read_input_tokens: 10 },
    });
    const u1 = e1.find((e) => e.type === 'usage');
    const u2 = e2.find((e) => e.type === 'usage');
    expect(u1?.type).toBe('usage');
    expect(u2?.type).toBe('usage');

    let total = zeroUsage();
    if (u1?.type === 'usage') total = mergeUsage(total, u1.usage);
    if (u2?.type === 'usage') total = mergeUsage(total, u2.usage);
    expect(total).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
    });
  });

  it('[TRANSLATE-005] turn_start/turn_end envelopes carry the turn number', () => {
    expect(translateCliMessage({ type: 'turn_start', turn: 1 })).toEqual([
      { type: 'turn.start', turn: 1 },
    ]);
    expect(translateCliMessage({ type: 'turn_end', turn: 1 })).toEqual([
      { type: 'turn.end', turn: 1 },
    ]);
    expect(translateCliMessage({ type: 'turn_start', turn: 2 })).toEqual([
      { type: 'turn.start', turn: 2 },
    ]);
  });

  it('[TRANSLATE-006] unknown envelope types return empty array without throwing', () => {
    expect(() => translateCliMessage({ type: 'future.unknown' })).not.toThrow();
    expect(translateCliMessage({ type: 'future.unknown' })).toEqual([]);

    const before = translateCliMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'before' },
    });
    const unknown = translateCliMessage({ type: 'future.unknown.event' });
    const after = translateCliMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'after' },
    });
    expect(before).toEqual([{ type: 'text.delta', delta: 'before' }]);
    expect(unknown).toEqual([]);
    expect(after).toEqual([{ type: 'text.delta', delta: 'after' }]);
  });

  it('[TRANSLATE-007] delta + final assistant msg must not double-emit text', () => {
    const deltaEvents = translateCliMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(deltaEvents).toEqual([{ type: 'text.delta', delta: 'hello' }]);

    // The CLI emits a final assistant envelope repeating the streamed text.
    // Translator deliberately skips text blocks inside assistant.content to
    // avoid double-counting in invoke() aggregators.
    const finalEvents = translateCliMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const textEvents = finalEvents.filter((e) => e.type === 'text.delta');
    expect(textEvents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // stream_event wrapper — unwraps and re-translates the inner event
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-STREAM-001] stream_event unwraps and translates the inner content_block_delta', () => {
    const events = translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'streamed' },
      },
    });
    expect(events).toEqual([{ type: 'text.delta', delta: 'streamed' }]);
  });

  it('[TRANSLATE-STREAM-002] stream_event with message_start unwraps to turn.start', () => {
    const events = translateCliMessage({
      type: 'stream_event',
      event: { type: 'message_start', turn: 3 },
    });
    expect(events).toEqual([{ type: 'turn.start', turn: 3 }]);
  });

  it('[TRANSLATE-STREAM-003] stream_event with a missing inner event returns []', () => {
    expect(translateCliMessage({ type: 'stream_event' })).toEqual([]);
    expect(translateCliMessage({ type: 'stream_event', event: null })).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Top-level tool_use / tool_result envelopes
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-TOOL-001] top-level tool_use yields tool.call with toolUseId', () => {
    const events = translateCliMessage({
      type: 'tool_use',
      id: 'toolu_top',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(events).toEqual([
      { type: 'tool.call', name: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_top' },
    ]);
  });

  it('[TRANSLATE-TOOL-002] top-level tool_use without name returns []', () => {
    expect(translateCliMessage({ type: 'tool_use', id: 'x' })).toEqual([]);
  });

  it('[TRANSLATE-TOOL-003] top-level tool_result with is_error: true maps to ok: false', () => {
    const events = translateCliMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_top',
      is_error: true,
    });
    expect(events).toEqual([
      { type: 'tool.result', name: 'unknown', ok: false, toolUseId: 'toolu_top' },
    ]);
  });

  it('[TRANSLATE-TOOL-004] top-level tool_result without is_error defaults to ok: true', () => {
    const events = translateCliMessage({
      type: 'tool_result',
      tool_use_id: 'toolu_top',
    });
    expect(events).toEqual([
      { type: 'tool.result', name: 'unknown', ok: true, toolUseId: 'toolu_top' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // result branch — stream.end contract
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-RESULT-001] result with stop_reason emits stream.end with that reason', () => {
    const events = translateCliMessage({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.stopReason).toBe('end_turn');
    }
  });

  it('[TRANSLATE-RESULT-002] result with missing stop_reason falls back to stream_completed', () => {
    const events = translateCliMessage({ type: 'result' });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.stopReason).toBe('stream_completed');
    }
  });

  it('[TRANSLATE-RESULT-003] result with empty-string stop_reason falls back to stream_completed', () => {
    const events = translateCliMessage({ type: 'result', stop_reason: '' });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.stopReason).toBe('stream_completed');
    }
  });

  it('[TRANSLATE-RESULT-004] result attaches total_cost_usd to stream.end as costUsd', () => {
    const events = translateCliMessage({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.0425,
    });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.costUsd).toBe(0.0425);
    }
  });

  it('[TRANSLATE-RESULT-005] result attaches session_id to stream.end as sessionId', () => {
    const events = translateCliMessage({
      type: 'result',
      stop_reason: 'end_turn',
      session_id: 'sess-xyz',
    });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.sessionId).toBe('sess-xyz');
    }
  });

  it('[TRANSLATE-RESULT-006] result without cost/session omits those fields on stream.end', () => {
    const events = translateCliMessage({ type: 'result', stop_reason: 'end_turn' });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    expect(streamEnd).toBeDefined();
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.costUsd).toBeUndefined();
      expect(streamEnd.sessionId).toBeUndefined();
    }
  });

  it('[TRANSLATE-RESULT-007] result with non-finite cost does not attach costUsd', () => {
    const events = translateCliMessage({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: Number.NaN,
    });
    const streamEnd = events.find((e) => e.type === 'stream.end');
    if (streamEnd?.type === 'stream.end') {
      expect(streamEnd.costUsd).toBeUndefined();
    }
  });

  it('[TRANSLATE-RESULT-008] result with usage emits usage event BEFORE stream.end', () => {
    const events = translateCliMessage({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(events[0]?.type).toBe('usage');
    expect(events[1]?.type).toBe('stream.end');
  });

  // ---------------------------------------------------------------------------
  // message_delta — explicit named branch
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-MSGDELTA-001] message_delta with usage emits usage event', () => {
    const events = translateCliMessage({
      type: 'message_delta',
      usage: { output_tokens: 7 },
    });
    expect(events).toHaveLength(1);
    const u = events[0];
    if (u?.type === 'usage') {
      expect(u.usage).toMatchObject({ outputTokens: 7 });
    } else {
      throw new Error('expected usage event');
    }
  });

  it('[TRANSLATE-MSGDELTA-002] message_delta without usage returns []', () => {
    expect(translateCliMessage({ type: 'message_delta' })).toEqual([]);
    expect(
      translateCliMessage({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Top-level usage object
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-TOPUSAGE-001] top-level usage on unknown envelope still yields usage event', () => {
    const events = translateCliMessage({
      type: 'custom_envelope',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(events).toHaveLength(1);
    const u = events[0];
    if (u?.type === 'usage') {
      expect(u.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    } else {
      throw new Error('expected usage event');
    }
  });

  // ---------------------------------------------------------------------------
  // Malformed / defensive
  // ---------------------------------------------------------------------------

  it('[TRANSLATE-MAL-001] non-object / non-record inputs return []', () => {
    expect(translateCliMessage(null)).toEqual([]);
    expect(translateCliMessage(undefined)).toEqual([]);
    expect(translateCliMessage('string')).toEqual([]);
    expect(translateCliMessage(42)).toEqual([]);
    expect(translateCliMessage([])).toEqual([]);
  });

  it('[TRANSLATE-MAL-002] envelopes without a string type return []', () => {
    expect(translateCliMessage({ foo: 'bar' })).toEqual([]);
    expect(translateCliMessage({ type: 123 })).toEqual([]);
  });
});

describe('extractResultSummary', () => {
  it('[SUMMARY-001] surfaces stopReason, sessionId, numTurns, model from result envelope', () => {
    const summary = extractResultSummary({
      type: 'result',
      stop_reason: 'end_turn',
      session_id: 'sess-1',
      num_turns: 3,
      model: 'claude-sonnet-4-6',
      total_cost_usd: 0.0425,
    });
    expect(summary).not.toBeNull();
    expect(summary?.stopReason).toBe('end_turn');
    expect(summary?.sessionId).toBe('sess-1');
    expect(summary?.numTurns).toBe(3);
    expect(summary?.model).toBe('claude-sonnet-4-6');
  });

  it('[SUMMARY-002] returns null for non-result envelopes', () => {
    expect(extractResultSummary({ type: 'assistant' })).toBeNull();
    expect(extractResultSummary(null)).toBeNull();
    expect(extractResultSummary(undefined)).toBeNull();
  });

  it('[SUMMARY-003] stop_reason passes through each documented value', () => {
    for (const stopReason of ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']) {
      const summary = extractResultSummary({ type: 'result', stop_reason: stopReason });
      expect(summary?.stopReason).toBe(stopReason);
    }
  });

  it('[SUMMARY-004] stop_reason = null is preserved as null (not undefined)', () => {
    const summary = extractResultSummary({ type: 'result', stop_reason: null });
    expect(summary?.stopReason).toBeNull();
  });

  it('[SUMMARY-005] missing stop_reason yields undefined (not null)', () => {
    const summary = extractResultSummary({ type: 'result' });
    expect(summary?.stopReason).toBeUndefined();
  });

  it('[SUMMARY-006] model falls back to result.model when top-level model is missing', () => {
    const summary = extractResultSummary({
      type: 'result',
      result: { model: 'claude-opus-4-7' },
    });
    expect(summary?.model).toBe('claude-opus-4-7');
  });

  it('[SUMMARY-007] missing model/numTurns/sessionId yield undefined (no fabricated defaults)', () => {
    const summary = extractResultSummary({ type: 'result' });
    expect(summary?.model).toBeUndefined();
    expect(summary?.numTurns).toBeUndefined();
    expect(summary?.sessionId).toBeUndefined();
  });
});

describe('mergeUsage', () => {
  it('[MERGE-001] sums each field', () => {
    const a: NormalizedUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    };
    const b: NormalizedUsage = {
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 4,
    };
    expect(mergeUsage(a, b)).toEqual({
      inputTokens: 13,
      outputTokens: 12,
      cacheReadTokens: 2,
      cacheCreationTokens: 5,
    });
  });

  it('[MERGE-002] fields missing from b contribute 0', () => {
    const a: NormalizedUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    };
    const b: Partial<NormalizedUsage> = { outputTokens: 3 };
    expect(mergeUsage(a, b)).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it('[MERGE-003] empty partial on b is a no-op', () => {
    const a: NormalizedUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    };
    expect(mergeUsage(a, {})).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through translateCliMessage — id correlation is the provider's
// concern, but the translator emits toolUseId on every tool event so the
// provider's Map can do its job.
// ---------------------------------------------------------------------------

describe('translateCliMessage — tool id correlation signal', () => {
  it('[CORR-001] tool.call and tool.result events carry toolUseId for provider-side pairing', () => {
    const calls = translateCliMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'a.ts' } }],
      },
    });
    const results = translateCliMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: false }],
      },
    });

    const call = calls[0];
    const result = results[0];

    const callId = call?.type === 'tool.call' ? call.toolUseId : undefined;
    const resultId = result?.type === 'tool.result' ? result.toolUseId : undefined;

    expect(callId).toBe('toolu_01');
    expect(resultId).toBe('toolu_01');
  });
});
