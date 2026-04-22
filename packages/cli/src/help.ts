/**
 * Splash help screen for `relay` (no arguments) and `relay --help`.
 *
 * Output matches product spec §6.1 verbatim, with the addition of `relay init`
 * as the first USAGE row (sprint-13 task_124 post-dated §6.1; see
 * _work/spec-amendment-init-command.md).
 *
 * Column layout note: the spec §6.1 uses two different verb column widths.
 * The first two USAGE rows ("relay <flow> [input]" and "relay run <flow>
 * [input]") have descriptions starting at col 35 (verb padEnd to 31).
 * All other rows have descriptions starting at col 36 (verb padEnd to 32).
 * This matches the spec byte-for-byte.
 */

import { MARK } from './visual.js';

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const INDENT = '    ';

/** Row with description at column 36 (verb column width = 32). */
function row(verb: string, desc: string): string {
  return `${INDENT}${verb.padEnd(32)}${desc}`;
}

/** Row with description at column 35 (verb column width = 31).
 *  Used only for the two spec rows whose original spacing lands at col 35:
 *  "relay <flow> [input]" and "relay run <flow> [input]". */
function row35(verb: string, desc: string): string {
  return `${INDENT}${verb.padEnd(31)}${desc}`;
}

// ---------------------------------------------------------------------------
// renderSplash
// ---------------------------------------------------------------------------

/**
 * Write the splash help screen to stdout.
 * Called when `relay` is invoked with no arguments or with the bare `--help`
 * flag (no subcommand).
 */
export function renderSplash(): void {
  const lines: string[] = [
    // Header — mark + wordmark tagline
    `${MARK}  relay · Claude pipelines you can run twice`,
    '',

    // USAGE — relay init added as first row per spec amendment
    'USAGE',
    row ('relay init',               'configure your race-running provider'),
    row35('relay <race> [input]',    'run a race (shorthand)'),
    row35('relay run <race> [input]','same, explicit form'),
    row ('relay resume <runId>',     'continue a failed or stopped run'),
    row ('relay doctor',             'check your environment before running'),
    '',

    // CATALOG
    'CATALOG',
    row('relay list',               'races installed in this project'),
    row('relay search <query>',     'find races in the public catalog'),
    row('relay install <race>',     'add a race to this project'),
    row('relay upgrade [<race>]',   'fetch the latest version'),
    '',

    // AUTHORING
    'AUTHORING',
    row('relay new <name>',         'scaffold a new race'),
    row('relay test [<race>]',      "run a race's snapshot tests"),
    row('relay publish',            'lint + publish a race to npm'),
    '',

    // DIAGNOSTICS
    'DIAGNOSTICS',
    row('relay runs',               'recent runs in this directory'),
    row('relay logs <runId>',       'structured run log'),
    row('relay --help <command>',   'help for a specific command'),
    '',

    // LEARN — MARK prefix with 3 spaces, verbatim from §6.1
    'LEARN',
    `${INDENT}${MARK}   relay.dev                    the catalog`,
    `${INDENT}${MARK}   relay.dev/docs/first-race    scaffold one in 5 minutes`,
  ];

  process.stdout.write(lines.join('\n') + '\n');
}
