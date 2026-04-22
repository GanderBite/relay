/**
 * `relay help glossary` — prints the five-term Relay glossary.
 *
 * Output (product spec §13):
 *
 *   ●─▶●─▶●─▶●  glossary
 *
 *   race        a named, versioned pipeline you can run
 *   runner      one node in a race (prompt, script, branch, parallel)
 *   baton       the JSON one runner produces and a later runner consumes
 *   run         one execution of a race; identified by a run id
 *   checkpoint  the saved state of a run after each runner completes
 */

import { MARK } from '../visual.js';

// ---------------------------------------------------------------------------
// Glossary entries (product spec §13 — verbatim)
// ---------------------------------------------------------------------------

const TERM_WIDTH = 12;

const ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['race',       'a named, versioned pipeline you can run'],
  ['runner',     'one node in a race (prompt, script, branch, parallel)'],
  ['baton',      'the JSON one runner produces and a later runner consumes'],
  ['run',        'one execution of a race; identified by a run id'],
  ['checkpoint', 'the saved state of a run after each runner completes'],
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
