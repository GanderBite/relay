import type { StepStatus } from '@ganderbite/relay-core';
import { SYMBOLS } from '../../brand.js';
import { gray, green, red, yellow } from '../../color.js';
import { fmtDuration, fmtK } from '../../format.js';
import { DURATION_WIDTH, STEP_NAME_WIDTH, TOKEN_WIDTH, TOOLS_WIDTH } from '../../layout.js';
import { renderStreamingLine } from '../../verboseStream.js';
import { fmtElapsedSec } from './helpers.js';
import type { StepDisplayState, VerboseAccumulator } from './types.js';

export function buildAccumulatorLines(acc: VerboseAccumulator): string[] {
  if (acc.textDeltaChars === 0) return acc.lines;
  const streamingLine = renderStreamingLine(acc.textDeltaChars);
  const result = acc.lines.slice(0, acc.streamingLineIndex);
  result.push(streamingLine);
  result.push(...acc.lines.slice(acc.streamingLineIndex));
  return result;
}

export function renderStepRow(
  state: StepDisplayState,
  spinnerFrame: number,
  steps: Map<string, StepDisplayState>,
  verbose: boolean,
  verboseAccumulators: Map<string, VerboseAccumulator> | null,
): string {
  const live = state.live;
  const status: StepStatus = live?.status ?? 'pending';

  let sym: string;
  switch (status) {
    case 'running':
      sym = yellow(SYMBOLS.spinner[spinnerFrame % SYMBOLS.spinner.length] ?? SYMBOLS.spinner[0]!);
      break;
    case 'succeeded':
      sym = green(SYMBOLS.ok);
      break;
    case 'failed':
      sym = red(SYMBOLS.fail);
      break;
    case 'skipped':
      sym = gray(SYMBOLS.ok);
      break;
    default:
      sym = gray(SYMBOLS.pending);
  }

  const nameCol = state.id.padEnd(STEP_NAME_WIDTH);

  if (status === 'pending' || live === null) {
    const unfinished = state.dependsOn.filter(
      (depId) => steps.get(depId)?.live?.status !== 'succeeded',
    );
    const detail =
      unfinished.length > 0 ? `waiting on ${unfinished.join(', ')}` : gray('not started');
    return ` ${sym} ${nameCol} ${detail}`;
  }

  if (status === 'running') {
    const tools = live.toolsSoFar ?? 0;
    const toolsCol = `${tools} tools`.padEnd(TOOLS_WIDTH);
    const runStart = state.runningStartedAt ?? live.startedAt;
    const elapsedCol = fmtElapsedSec(runStart).padEnd(DURATION_WIDTH);
    const tokensCol = fmtK(live.tokensSoFar ?? 0).padEnd(TOKEN_WIDTH);
    const stepRowLine = ` ${sym} ${nameCol} ${toolsCol} ${elapsedCol} ${tokensCol}`;
    if (verbose) {
      const acc = verboseAccumulators?.get(state.id);
      if (acc !== undefined) {
        const subLines = buildAccumulatorLines(acc);
        if (subLines.length > 0) return [stepRowLine, ...subLines].join('\n');
      }
    }
    return stepRowLine;
  }

  // Succeeded / failed / skipped — show frozen metrics
  const tools = live.toolsSoFar ?? 0;
  const toolsCol = `${tools} tools`.padEnd(TOOLS_WIDTH);
  const durStr = fmtDuration(state.finalDurationMs ?? 0).padEnd(DURATION_WIDTH);
  const finalTokens = (state.finalTokensIn ?? 0) + (state.finalTokensOut ?? 0);
  const tokensCol = fmtK(finalTokens).padEnd(TOKEN_WIDTH);

  let terminalRow: string;
  if (status === 'succeeded') {
    terminalRow = ` ${green(SYMBOLS.ok)} ${nameCol} ${toolsCol} ${durStr} ${tokensCol}`;
  } else if (status === 'failed') {
    terminalRow = ` ${red(SYMBOLS.fail)} ${nameCol} ${toolsCol} ${durStr} ${tokensCol}`;
  } else {
    terminalRow = ` ${gray(SYMBOLS.ok)} ${nameCol} ${toolsCol} ${durStr} ${tokensCol}`;
  }

  if (verbose) {
    const acc = verboseAccumulators?.get(state.id);
    if (acc !== undefined) {
      const subLines = buildAccumulatorLines(acc);
      if (subLines.length > 0) return [terminalRow, ...subLines].join('\n');
    }
  }
  return terminalRow;
}
