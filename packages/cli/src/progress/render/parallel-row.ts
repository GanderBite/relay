import { SYMBOLS } from '../../brand.js';
import { gray, green, red, yellow } from '../../color.js';
import { fmtK } from '../../format.js';
import { DURATION_WIDTH, STEP_NAME_WIDTH, TOKEN_WIDTH } from '../../layout.js';
import { fmtElapsedSec } from './helpers.js';
import { renderStepRow } from './step-row.js';
import type { StepDisplayState, VerboseAccumulator } from './types.js';

/** Width of the "N branches" column — accommodates "99 branches" (11) with margin. */
const BRANCHES_WIDTH = 12;

/** Compute cumulative tokens across all branch step states. */
function sumBranchTokens(
  branchIds: readonly string[],
  branchStates: Map<string, StepDisplayState>,
): number {
  let total = 0;
  for (const branchId of branchIds) {
    const state = branchStates.get(branchId);
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

/** Choose a status symbol for the parallel parent row based on its live state. */
function parallelSymbol(parallelState: StepDisplayState, spinnerFrame: number): string {
  const status = parallelState.live?.status ?? 'pending';
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
 * Render a parallel step's parent row followed by its indented branch step rows.
 *
 * Parallel parent row format:
 *   <sym> <name padded>  <N branches padded>  <elapsed padded>  <sumTokens padded>
 *
 * Each branch step is rendered with a 4-space indent using renderStepRow.
 * Multi-line output from renderStepRow (verbose sub-lines) is indented on
 * every line so continuation lines stay visually grouped under the parent.
 *
 * @param parallelId           The parallel step's own ID.
 * @param parallelDisplayState The StepDisplayState for the parallel parent.
 * @param branchStates         Map of branch step ID to StepDisplayState.
 * @param branchIds            Ordered branch step IDs.
 * @param spinnerFrame         Current spinner frame index for in-flight steps.
 * @param verbose              Whether verbose mode is active.
 * @param verboseAccumulators  Verbose accumulator map or null.
 */
export function renderParallelRow(
  parallelId: string,
  parallelDisplayState: StepDisplayState,
  branchStates: Map<string, StepDisplayState>,
  branchIds: readonly string[],
  spinnerFrame: number,
  verbose: boolean,
  verboseAccumulators: Map<string, VerboseAccumulator> | null,
): string {
  const sym = parallelSymbol(parallelDisplayState, spinnerFrame);
  const nameCol = parallelId.padEnd(STEP_NAME_WIDTH);

  const live = parallelDisplayState.live;
  const status = live?.status ?? 'pending';

  if (status === 'pending' || live === null) {
    const row = ` ${sym} ${nameCol} ${gray('not started')}`;
    return row;
  }

  const branchCount =
    parallelDisplayState.live?.branchCount !== undefined
      ? parallelDisplayState.live.branchCount
      : branchIds.length;
  const branchesCol = `${branchCount} branches`.padEnd(BRANCHES_WIDTH);

  const startedAt = parallelDisplayState.runningStartedAt ?? live.startedAt ?? '';
  const elapsedCol = fmtElapsedSec(startedAt).padEnd(DURATION_WIDTH);

  const tokens = sumBranchTokens(branchIds, branchStates);
  const tokensCol = fmtK(tokens).padEnd(TOKEN_WIDTH);

  const parentRow = ` ${sym} ${nameCol} ${branchesCol} ${elapsedCol} ${tokensCol}`;

  const branchRows: string[] = [];
  for (const branchId of branchIds) {
    const branchState = branchStates.get(branchId);
    if (branchState === undefined) continue;
    const rendered = renderStepRow(
      branchState,
      spinnerFrame,
      branchStates,
      verbose,
      verboseAccumulators,
    );
    const indented = rendered
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    branchRows.push(indented);
  }

  if (branchRows.length === 0) return parentRow;
  return [parentRow, ...branchRows].join('\n');
}
