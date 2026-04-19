import { describe, it, expect } from 'vitest';

import {
  extractSdkResultSummary,
  mergeUsage,
  translateSdkMessage,
} from '../../../src/providers/claude/translate.js';
import type { NormalizedUsage } from '../../../src/providers/types.js';

function zeroUsage(): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

describe('translateSdkMessage', () => {
  it('[TRANSLATE-001] assistant text blocks are skipped; tool_use blocks yield tool.call', () => {
    const textOnly = translateSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(textOnly).toHaveLength(0);

    const withTool = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'x.ts' } }],
      },
    });
    expect(withTool).toHaveLength(1);
    expect(withTool[0]).toMatchObject({ type: 'tool.call', name: 'Read', input: { path: 'x.ts' } });
  });

  it('[TRANSLATE-002] assistant tool_use block yields tool.call with name + input', () => {
    const events = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'x.ts' } },
        ],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool.call',
      name: 'Read',
      input: { path: 'x.ts' },
    });
  });

  it('[TRANSLATE-003] tool_result is_error maps to ok flag', () => {
    const okEvents = translateSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: 'ok' }],
      },
    });
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0]).toMatchObject({ type: 'tool.result', ok: true });

    const errEvents = translateSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: true }],
      },
    });
    expect(errEvents[0]).toMatchObject({ type: 'tool.result', ok: false });
  });

  it('[TRANSLATE-004] partial usage events aggregate via mergeUsage', () => {
    const e1 = translateSdkMessage({
      type: 'result',
      usage: { input_tokens: 100 },
    });
    const e2 = translateSdkMessage({
      type: 'result',
      usage: { output_tokens: 50, cache_read_input_tokens: 10 },
    });
    expect(e1[0]?.type).toBe('usage');
    expect(e2[0]?.type).toBe('usage');

    let total = zeroUsage();
    if (e1[0]?.type === 'usage') total = mergeUsage(total, e1[0].usage);
    if (e2[0]?.type === 'usage') total = mergeUsage(total, e2[0].usage);
    expect(total).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
    });
  });

  it('[TRANSLATE-005] turn_start/turn_end events carry the SDK turn number', () => {
    expect(translateSdkMessage({ type: 'turn_start', turn: 1 })).toEqual([
      { type: 'turn.start', turn: 1 },
    ]);
    expect(translateSdkMessage({ type: 'turn_end', turn: 1 })).toEqual([
      { type: 'turn.end', turn: 1 },
    ]);
    expect(translateSdkMessage({ type: 'turn_start', turn: 2 })).toEqual([
      { type: 'turn.start', turn: 2 },
    ]);
  });

  it('[TRANSLATE-006] unknown SDK message types return empty array without throwing', () => {
    expect(() => translateSdkMessage({ type: 'future.unknown' })).not.toThrow();
    expect(translateSdkMessage({ type: 'future.unknown' })).toEqual([]);

    const before = translateSdkMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'before' },
    });
    const unknown = translateSdkMessage({ type: 'future.unknown.event' });
    const after = translateSdkMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'after' },
    });
    expect(before).toEqual([{ type: 'text.delta', delta: 'before' }]);
    expect(unknown).toEqual([]);
    expect(after).toEqual([{ type: 'text.delta', delta: 'after' }]);
  });

  it('[TRANSLATE-007] delta + final assistant msg must not double-emit text (FLAG-8)', () => {
    // Streaming delta first
    const deltaEvents = translateSdkMessage({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(deltaEvents).toEqual([{ type: 'text.delta', delta: 'hello' }]);

    // Then the final assistant message carrying the same text AND usage.
    // Desired contract: the translator should NOT emit a second text.delta for
    // the same content — the caller already accumulated it during streaming.
    const finalEvents = translateSdkMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const textEvents = finalEvents.filter((e) => e.type === 'text.delta');
    expect(textEvents).toHaveLength(0);
  });
});

describe('extractSdkResultSummary', () => {
  it('[TRANSLATE-008] surfaces stopReason, sessionId, numTurns from result envelope', () => {
    const summary = extractSdkResultSummary({
      type: 'result',
      stop_reason: 'end_turn',
      session_id: 'sess-1',
      num_turns: 3,
      total_cost_usd: 0.0425,
    });
    expect(summary).not.toBeNull();
    expect(summary?.stopReason).toBe('end_turn');
    expect(summary?.sessionId).toBe('sess-1');
    expect(summary?.numTurns).toBe(3);
    // Documents the FLAG-12/13 gap: total_cost_usd is present on the SDK
    // envelope but is NOT propagated into SdkResultSummary. Until the gap is
    // closed, downstream InvocationResponse.costUsd remains undefined.
    expect((summary as Record<string, unknown>)?.['costUsd']).toBeUndefined();
  });
});
