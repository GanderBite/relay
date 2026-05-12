import type { Flow, StepStatus } from '@ganderbite/relay-core';
import { SYMBOLS } from '../../brand.js';
import { gray, green, red, yellow } from '../../color.js';
import { fmtCostApprox, fmtK } from '../../format.js';
import { DURATION_WIDTH, MODEL_WIDTH, STEP_NAME_WIDTH } from '../../layout.js';
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
  _flow: Flow<unknown>,
  cumulativeTokens: number,
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
    const model = (live.model ?? '-').padEnd(MODEL_WIDTH);
    const tools = live.toolsSoFar ?? 0;
    const runStart = state.runningStartedAt ?? live.startedAt;
    const progressCol = (tools > 0 ? `${tools} tools` : fmtElapsedSec(runStart)).padEnd(
      DURATION_WIDTH,
    );
    const tokensCol = fmtK(cumulativeTokens + (live.tokensSoFar ?? 0)).padEnd(13);
    const stepRowLine = ` ${sym} ${nameCol} ${model} ${progressCol} ${tokensCol}`;
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
  const model = (live.model ?? state.finalModel ?? '-').padEnd(MODEL_WIDTH);
  const durSec = (state.finalDurationMs ?? 0) / 1000;
  const durStr = (durSec < 10 ? `${durSec.toFixed(1)}s` : `${Math.round(durSec)}s`).padEnd(
    DURATION_WIDTH,
  );
  const tokensCol = fmtK(
    state.cumulativeTokens ?? (state.finalTokensIn ?? 0) + (state.finalTokensOut ?? 0),
  ).padEnd(13);
  const costStr = fmtCostApprox(state.finalCostUsd ?? 0);
  const terminalRow =
    status === 'succeeded'
      ? ` ${green(SYMBOLS.ok)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${green(costStr)}`
      : ` ${red(SYMBOLS.fail)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${red(costStr)}`;

  if (verbose) {
    const acc = verboseAccumulators?.get(state.id);
    if (acc !== undefined) {
      const subLines = buildAccumulatorLines(acc);
      if (subLines.length > 0) return [terminalRow, ...subLines].join('\n');
    }
  }
  return terminalRow;
}
