import { SYMBOLS } from '../../brand.js';
import { gray, green, red, yellow } from '../../color.js';
import { fmtK } from '../../format.js';
import { DURATION_WIDTH, STEP_NAME_WIDTH, TOKEN_WIDTH } from '../../layout.js';
import { fmtElapsedSec } from './helpers.js';
import { renderStepRow } from './step-row.js';
import type { StepDisplayState } from './types.js';

/** Width of the iter column — accommodates "iter 99/99" (10) with margin. */
const ITER_WIDTH = 12;

/** Compute cumulative tokens across all body steps. */
function sumBodyTokens(
  bodyTopoOrder: readonly string[],
  bodyStates: Map<string, StepDisplayState>,
): number {
  let total = 0;
  for (const bodyId of bodyTopoOrder) {
    const state = bodyStates.get(bodyId);
    if (state === undefined) continue;
    const live = state.live;
    if (live?.status === 'succeeded' || live?.status === 'failed' || live?.status === 'skipped') {
      total += (state.finalTokensIn ?? 0) + (state.finalTokensOut ?? 0);
    } else if (live?.status === 'running') {
      total += live.tokensSoFar ?? 0;
    }
  }
  return total;
}

/** Choose a status symbol for the loop parent row based on its live state. */
function loopSymbol(loopState: StepDisplayState, spinnerFrame: number): string {
  const status = loopState.live?.status ?? 'pending';
  switch (status) {
    case 'running':
      return yellow(SYMBOLS.spinner[spinnerFrame % SYMBOLS.spinner.length] ?? SYMBOLS.spinner[0]!);
    case 'succeeded':
      return green(SYMBOLS.ok);
    case 'failed':
      return red(SYMBOLS.fail);
    case 'skipped':
      return gray(SYMBOLS.ok);
    default:
      return gray(SYMBOLS.pending);
  }
}

/**
 * Render a loop step's parent row followed by its indented body step rows.
 *
 * Loop parent row format:
 *   <sym> <name padded>  iter <N>/<max>  <elapsed padded>  <sumTokens padded>
 *
 * Each body step is rendered with a 4-space indent using renderStepRow.
 * Multi-line output from renderStepRow (verbose sub-lines) is indented on
 * every line so continuation lines stay visually grouped under the parent.
 *
 * @param loopId           The loop step's own ID.
 * @param loopDisplayState The StepDisplayState for the loop parent.
 * @param bodyStates       Map of body step ID to StepDisplayState.
 * @param bodyTopoOrder    Ordered body step IDs (from bodyGraph.topoOrder or body key order).
 * @param spinnerFrame     Current spinner frame index for in-flight steps.
 * @param verbose          Whether verbose mode is active.
 * @param verboseAccumulators  Verbose accumulator map or null.
 */
export function renderLoopRow(
  loopId: string,
  loopDisplayState: StepDisplayState,
  bodyStates: Map<string, StepDisplayState>,
  bodyTopoOrder: readonly string[],
  spinnerFrame: number,
  verbose: boolean,
  verboseAccumulators: Map<string, import('./types.js').VerboseAccumulator> | null,
): string {
  const sym = loopSymbol(loopDisplayState, spinnerFrame);
  const nameCol = loopId.padEnd(STEP_NAME_WIDTH);

  const live = loopDisplayState.live;
  const status = live?.status ?? 'pending';

  // Pending loop: show minimal row with no iter info
  if (status === 'pending' || live === null) {
    const row = ` ${sym} ${nameCol} ${gray('not started')}`;
    return row;
  }

  const currentIter = live.iter ?? 1;
  const maxIter = live.maxIter !== undefined ? String(live.maxIter) : '?';
  const iterCol = `iter ${currentIter}/${maxIter}`.padEnd(ITER_WIDTH);

  const startedAt = loopDisplayState.runningStartedAt ?? live.startedAt ?? '';
  const elapsedCol = fmtElapsedSec(startedAt).padEnd(DURATION_WIDTH);

  const tokens = sumBodyTokens(bodyTopoOrder, bodyStates);
  const tokensCol = fmtK(tokens).padEnd(TOKEN_WIDTH);

  const parentRow = ` ${sym} ${nameCol} ${iterCol} ${elapsedCol} ${tokensCol}`;

  // Render each body step with 4-space indent on every line (including verbose sub-lines).
  const bodyRows: string[] = [];
  for (const bodyId of bodyTopoOrder) {
    const bodyState = bodyStates.get(bodyId);
    if (bodyState === undefined) continue;
    const rendered = renderStepRow(
      bodyState,
      spinnerFrame,
      bodyStates,
      verbose,
      verboseAccumulators,
    );
    const indented = rendered
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    bodyRows.push(indented);
  }

  if (bodyRows.length === 0) return parentRow;
  return [parentRow, ...bodyRows].join('\n');
}
