/**
 * Shared renderer for per-step InvocationEvent records.
 *
 * Both the live progress display (sprint-41) and the retroactive `relay logs`
 * command (sprint-42) import this module. The 4-space indent is applied inside
 * each function so callers get identical output on both paths.
 *
 * Color rules (product spec §4.3):
 *   - Gray   — system.init, tool.call, turn.start, usage, stream.end
 *   - Red    — tool.result failure, stream.error
 *   - No new symbols introduced — only the existing SYMBOLS vocabulary from brand.ts.
 */

import type { EventRecord } from '@ganderbite/relay-core';

import { SYMBOLS } from './brand.js';
import { gray, red } from './color.js';
import { fmtK } from './format.js';

// ---------------------------------------------------------------------------
// renderVerboseEvent
// ---------------------------------------------------------------------------

/**
 * Renders one EventRecord into a formatted CLI line (no trailing newline),
 * or returns null when the event type produces no output.
 *
 * The 4-space indent prefix is included in the returned string so both live
 * and retroactive callers get identical output.
 */
export function renderVerboseEvent(
  record: EventRecord,
  _opts?: { stripAnsi?: boolean },
): string | null {
  const ev = record.event;

  switch (ev.type) {
    case 'system.init': {
      const toolList = ev.tools !== undefined && ev.tools.length > 0 ? ev.tools.join(', ') : 'none';
      return gray(
        `    ${SYMBOLS.dot} model: ${ev.model ?? '(unknown)'}  session: ${ev.sessionId ?? '-'}  tools: ${toolList}`,
      );
    }

    case 'tool.call': {
      const inputStr = JSON.stringify(ev.input ?? {}).slice(0, 60);
      return gray(`    ${SYMBOLS.dot} ${ev.name}(${inputStr})`);
    }

    case 'tool.result': {
      if (ev.ok) {
        return gray(`    ${SYMBOLS.ok} ${ev.name} returned`);
      }
      return red(`    ${SYMBOLS.fail} ${ev.name} failed`);
    }

    case 'turn.start': {
      return gray(`    ${SYMBOLS.dot} turn ${ev.turn}`);
    }

    case 'turn.end': {
      return null;
    }

    case 'text.delta': {
      return null;
    }

    case 'usage': {
      const inputTokens = ev.usage.inputTokens ?? 0;
      const outputTokens = ev.usage.outputTokens ?? 0;
      const cacheReadTokens = ev.usage.cacheReadTokens ?? 0;
      return gray(
        `    ${SYMBOLS.dot} usage  in: ${inputTokens}  out: ${outputTokens}  cache: ${cacheReadTokens}`,
      );
    }

    case 'stream.end': {
      const costPart = ev.costUsd !== undefined ? `  $${ev.costUsd.toFixed(4)}` : '';
      return gray(`    ${SYMBOLS.dot} done  ${ev.stopReason}${costPart}`);
    }

    case 'stream.error': {
      return red(`    ${SYMBOLS.fail} error: ${ev.error.message}`);
    }

    default: {
      // Exhaustiveness guard — unknown future event types produce no output.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// renderStreamingLine
// ---------------------------------------------------------------------------

/**
 * Returns the live-updating text-delta line shown while a step is streaming.
 * Callers replace this line in-place on each update by tracking the cursor.
 */
export function renderStreamingLine(charCount: number): string {
  return `    ${gray(SYMBOLS.dot)} streaming  ${gray('···')}  ${charCount} chars`;
}

// ---------------------------------------------------------------------------
// renderStepSummary
// ---------------------------------------------------------------------------

/**
 * Returns the one-line completion summary that replaces the sub-stream
 * display when a step finishes.
 */
export function renderStepSummary(summary: {
  turns: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}): string {
  const { turns, tools, tokensIn, tokensOut, costUsd } = summary;
  const turnLabel = turns === 1 ? 'turn' : 'turns';
  const toolLabel = tools === 1 ? 'tool' : 'tools';
  const costPart = costUsd !== undefined ? `  ${gray(SYMBOLS.dot)}  $${costUsd.toFixed(3)}` : '';
  return (
    `    ${gray(SYMBOLS.dot)} ${turns} ${turnLabel}  ${gray(SYMBOLS.dot)}  ${tools} ${toolLabel}  ${gray(SYMBOLS.dot)}  ` +
    `${fmtK(tokensIn)} in / ${fmtK(tokensOut)} out${costPart}`
  );
}
