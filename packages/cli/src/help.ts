/**
 * Splash help screen for `relay` (no arguments) and `relay --help`.
 *
 * Output matches product spec §6.1 verbatim, with the addition of `relay init`
 * as the first USAGE row.
 */

import { MARK } from './brand.js';

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const INDENT = '    ';

/** Row with description at column 36 (verb column width = 32). */
function row(verb: string, desc: string): string {
  return `${INDENT}${verb.padEnd(32)}${desc}`;
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
    `${MARK}  relay · Claude flows you can run twice`,
    '',

    // USAGE — relay init added as first row per spec amendment
    'USAGE',
    row('relay init', 'configure your flow-running provider'),
    row('relay run <flow> [input]', 'run a flow'),
    row('relay resume <runId>', 'continue a failed or stopped run'),
    row('relay doctor', 'check your environment before running'),
    '',

    // CATALOG
    'CATALOG',
    row('relay list', 'flows installed in this project'),
    row('relay search <query>', 'find flows in the public catalog'),
    row('relay install <flow>', 'add a flow to this project'),
    row('relay upgrade [<flow>]', 'fetch the latest version'),
    '',

    // AUTHORING
    'AUTHORING',
    row('relay new <name>', 'scaffold a new flow'),
    row('relay test [<flow>]', "run a flow's snapshot tests"),
    row('relay publish', 'lint + publish a flow to npm'),
    '',

    // DIAGNOSTICS
    'DIAGNOSTICS',
    row('relay runs', 'recent runs in this directory'),
    row('relay logs <runId>', 'structured run log'),
    row('relay --help <command>', 'help for a specific command'),
    '',

    // LEARN — MARK prefix with 3 spaces, verbatim from §6.1
    'LEARN',
    `${INDENT}${MARK}   relay.dev                    the catalog`,
    `${INDENT}${MARK}   relay.dev/docs/first-flow    scaffold one in 5 minutes`,
  ];

  process.stdout.write(lines.join('\n') + '\n');
}
