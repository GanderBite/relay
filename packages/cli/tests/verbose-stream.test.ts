/**
 * Snapshot tests for verboseStream.ts render functions.
 *
 * Color is disabled via NO_COLOR before any render call so snapshots are
 * deterministic across environments (no ANSI escape sequences in output).
 *
 * EventRecord literals are constructed inline using the real EventRecord type
 * shape: { seq, ts, attempt, event }.
 * The usage event carries nested `event.usage.inputTokens` etc., NOT flat fields
 * on the event itself (verified from providers/types.ts InvocationEvent union).
 */

import type { EventRecord } from '@ganderbite/relay-core';
import { PipelineError } from '@ganderbite/relay-core';
import { beforeAll, describe, expect, it } from 'vitest';

import { initColor } from '../src/color.js';
import {
  renderStepSummary,
  renderStreamingLine,
  renderVerboseEvent,
} from '../src/verboseStream.js';

// ---------------------------------------------------------------------------
// Color must be disabled before any render call to keep snapshots stable.
// ---------------------------------------------------------------------------

beforeAll(() => {
  initColor({ noColor: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(event: EventRecord['event']): EventRecord {
  return { seq: 1, ts: '2026-01-01T00:00:00.000Z', attempt: 1, event };
}

// ---------------------------------------------------------------------------
// renderVerboseEvent — one snapshot per event type
// ---------------------------------------------------------------------------

describe('renderVerboseEvent', () => {
  it('system.init with model, sessionId, tools, mcpServers', () => {
    const record = makeRecord({
      type: 'system.init',
      model: 'claude-opus-4-5',
      sessionId: 'sess-abc123',
      tools: ['Bash', 'Read'],
      mcpServers: [],
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('system.init with undefined tools renders "none"', () => {
    const record = makeRecord({
      type: 'system.init',
      model: 'claude-opus-4-5',
      sessionId: 'sess-abc123',
      tools: undefined,
      mcpServers: undefined,
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('tool.call with name and input', () => {
    const record = makeRecord({
      type: 'tool.call',
      name: 'Bash',
      input: { cmd: 'ls' },
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('tool.result ok=true', () => {
    const record = makeRecord({
      type: 'tool.result',
      name: 'Bash',
      ok: true,
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('tool.result ok=false', () => {
    const record = makeRecord({
      type: 'tool.result',
      name: 'Read',
      ok: false,
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('turn.start turn=1', () => {
    const record = makeRecord({ type: 'turn.start', turn: 1 });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('usage with nested usage object', () => {
    const record = makeRecord({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 0 },
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('stream.end with stopReason and costUsd', () => {
    const record = makeRecord({
      type: 'stream.end',
      stopReason: 'end_turn',
      costUsd: 0.002,
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('stream.error renders the error message', () => {
    const err = new PipelineError('test error for stream.error');
    const record = makeRecord({
      type: 'stream.error',
      error: err,
    });
    expect(renderVerboseEvent(record)).toMatchSnapshot();
  });

  it('text.delta returns null', () => {
    const record = makeRecord({ type: 'text.delta', delta: 'hello' });
    expect(renderVerboseEvent(record)).toBeNull();
  });

  it('turn.end returns null', () => {
    const record = makeRecord({ type: 'turn.end', turn: 1 });
    expect(renderVerboseEvent(record)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderStreamingLine
// ---------------------------------------------------------------------------

describe('renderStreamingLine', () => {
  it('renderStreamingLine(238) matches snapshot', () => {
    expect(renderStreamingLine(238)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// renderStepSummary
// ---------------------------------------------------------------------------

describe('renderStepSummary', () => {
  it('renders turns, tools, tokens, and cost', () => {
    expect(
      renderStepSummary({ turns: 2, tools: 3, tokensIn: 1200, tokensOut: 340, costUsd: 0.012 }),
    ).toMatchSnapshot();
  });

  it('renders without cost when costUsd is absent', () => {
    expect(
      renderStepSummary({ turns: 1, tools: 1, tokensIn: 500, tokensOut: 120 }),
    ).toMatchSnapshot();
  });

  it('uses singular "turn" and "tool" labels for counts of 1', () => {
    const line = renderStepSummary({ turns: 1, tools: 1, tokensIn: 10, tokensOut: 5 });
    expect(line).toContain('1 turn');
    expect(line).toContain('1 tool');
    expect(line).not.toContain('1 turns');
    expect(line).not.toContain('1 tools');
  });

  it('uses plural "turns" and "tools" labels for counts > 1', () => {
    const line = renderStepSummary({ turns: 2, tools: 3, tokensIn: 10, tokensOut: 5 });
    expect(line).toContain('2 turns');
    expect(line).toContain('3 tools');
  });
});

// ---------------------------------------------------------------------------
// Brand grammar smoke check
// ---------------------------------------------------------------------------

/**
 * Allowlisted non-ASCII code points drawn from the canonical SYMBOLS vocabulary
 * in brand.ts, the mark glyphs (●, ─, ▶), and the spinner frames.
 *
 * Any non-ASCII character NOT in this set signals a brand-grammar violation.
 */
const ALLOWED_NON_ASCII = new Set<number>([
  0x2713, // ✓ ok
  0x2715, // ✕ fail
  0x26a0, // ⚠ warn
  0x280b, // ⠋ spinner-0
  0x2819, // ⠙ spinner-1
  0x2839, // ⠹ spinner-2
  0x2838, // ⠸ spinner-3
  0x283c, // ⠼ spinner-4
  0x2834, // ⠴ spinner-5
  0x2826, // ⠦ spinner-6
  0x2827, // ⠧ spinner-7
  0x2807, // ⠇ spinner-8
  0x280f, // ⠏ spinner-9
  0x25cb, // ○ pending
  0x00b7, // · dot (middle dot, U+00B7)
  0x2027, // · dot (hyphenation point, U+2027) — check both code points
  0x25ba, // ► arrow (alternate)
  0x25b6, // ▶ arrow
  0x2296, // ⊘ cancelled
  0x2015, // ─ horizontal bar (alternate)
  0x2500, // ─ box drawings light horizontal
  0x25cf, // ● filled circle
]);

function checkBrandGrammar(line: string): void {
  // No trailing exclamation mark.
  expect(line).not.toMatch(/!$/);

  // No "simply".
  expect(line.toLowerCase()).not.toContain('simply');

  // Every non-ASCII code point must be in the canonical allowlist.
  for (const char of line) {
    const cp = char.codePointAt(0)!;
    if (cp >= 128) {
      expect(
        ALLOWED_NON_ASCII.has(cp),
        `unexpected non-ASCII char U+${cp.toString(16).toUpperCase().padStart(4, '0')} ("${char}") in rendered line: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  }
}

describe('brand grammar smoke check', () => {
  const allRecords: EventRecord[] = [
    makeRecord({
      type: 'system.init',
      model: 'claude-opus-4-5',
      sessionId: 'sess-xyz',
      tools: ['Bash', 'Read', 'Write'],
      mcpServers: [],
    }),
    makeRecord({ type: 'tool.call', name: 'Bash', input: { cmd: 'ls -la' } }),
    makeRecord({ type: 'tool.result', name: 'Bash', ok: true }),
    makeRecord({ type: 'tool.result', name: 'Read', ok: false }),
    makeRecord({ type: 'turn.start', turn: 1 }),
    makeRecord({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 0 },
    }),
    makeRecord({ type: 'stream.end', stopReason: 'end_turn', costUsd: 0.002 }),
    // text.delta and turn.end produce null — excluded from the non-null iteration
    makeRecord({ type: 'text.delta', delta: 'some output text' }),
    makeRecord({ type: 'turn.end', turn: 1 }),
  ];

  it('all non-null rendered lines satisfy brand grammar constraints', () => {
    const nonNullLines = allRecords
      .map((r) => renderVerboseEvent(r))
      .filter((line): line is string => line !== null);

    // At minimum system.init, tool.call, two tool.result, turn.start, usage, stream.end
    expect(nonNullLines.length).toBeGreaterThanOrEqual(7);

    for (const line of nonNullLines) {
      checkBrandGrammar(line);
    }
  });

  it('renderStreamingLine satisfies brand grammar constraints', () => {
    checkBrandGrammar(renderStreamingLine(100));
  });

  it('renderStepSummary satisfies brand grammar constraints', () => {
    checkBrandGrammar(
      renderStepSummary({ turns: 2, tools: 3, tokensIn: 1200, tokensOut: 340, costUsd: 0.012 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Non-TTY parity: spot checks on specific event types
// ---------------------------------------------------------------------------

describe('non-TTY parity', () => {
  it('tool.result ok=true produces a line containing the success symbol', () => {
    const record = makeRecord({ type: 'tool.result', name: 'Bash', ok: true });
    const line = renderVerboseEvent(record);
    expect(line).not.toBeNull();
    expect(line).toContain('✓');
  });

  it('tool.result ok=false produces a line containing the failure symbol', () => {
    const record = makeRecord({ type: 'tool.result', name: 'Read', ok: false });
    const line = renderVerboseEvent(record);
    expect(line).not.toBeNull();
    expect(line).toContain('✕');
  });

  it('all non-null rendered lines are strings', () => {
    const records: EventRecord[] = [
      makeRecord({
        type: 'system.init',
        model: 'claude-opus-4-5',
        sessionId: 'sess-abc',
        tools: ['Bash'],
        mcpServers: [],
      }),
      makeRecord({ type: 'tool.call', name: 'Bash', input: {} }),
      makeRecord({ type: 'tool.result', name: 'Bash', ok: true }),
      makeRecord({ type: 'turn.start', turn: 2 }),
      makeRecord({
        type: 'usage',
        usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
      makeRecord({ type: 'stream.end', stopReason: 'end_turn' }),
    ];

    for (const record of records) {
      const line = renderVerboseEvent(record);
      expect(typeof line).toBe('string');
    }
  });
});
