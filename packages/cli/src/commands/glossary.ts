/**
 * `relay help glossary` — prints the five-term Relay glossary.
 *
 * Output (product spec §13):
 *
 *   ●─▶●─▶●─▶●  glossary
 *
 *   flow        a named, versioned sequence of steps you can run
 *   step        one node in a flow (prompt, script, branch, parallel)
 *   handoff     the JSON one step produces and a later step consumes
 *   run         one execution of a flow; identified by a run id
 *   checkpoint  the saved state of a run after each step completes
 */

import { MARK } from '../visual.js';

// ---------------------------------------------------------------------------
// Glossary entries (product spec §13 — verbatim)
// ---------------------------------------------------------------------------

const TERM_WIDTH = 12;

const ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['flow', 'a named, versioned sequence of steps you can run'],
  ['step', 'one node in a flow (prompt, script, branch, parallel)'],
  ['handoff', 'the JSON one step produces and a later step consumes'],
  ['run', 'one execution of a flow; identified by a run id'],
  ['checkpoint', 'the saved state of a run after each step completes'],
];

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay help glossary`.
 * Prints the five-term glossary to stdout and exits 0.
 */
export default async function glossaryCommand(_args: unknown[], _opts: unknown): Promise<void> {
  process.stdout.write(`${MARK}  glossary\n`);
  process.stdout.write('\n');

  for (const [term, definition] of ENTRIES) {
    process.stdout.write(`${term.padEnd(TERM_WIDTH)}${definition}\n`);
  }
}
