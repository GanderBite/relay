import { Command } from 'commander';
import { initColor } from './color.js';
import { looksLikePath } from './util/path.js';

/**
 * Classic two-row dynamic-programming Levenshtein distance.
 * Returns the edit distance between strings a and b.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // prev[j] holds the distance for the row above; curr[j] for the current row.
  const prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const curr: number[] = new Array(n + 1).fill(0) as number[];
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] ?? 0;
      const del = prev[j] ?? 0;
      const ins = curr[j - 1] ?? 0;
      curr[j] = a[i - 1] === b[j - 1] ? sub : 1 + Math.min(del, ins, sub);
    }
    // Swap rows for next iteration.
    for (let k = 0; k <= n; k++) prev[k] = curr[k] ?? 0;
  }
  return prev[n] ?? 0;
}

// All v1 command names — used for shorthand routing (first-positional bypass).
const KNOWN_COMMANDS = new Set([
  'answer',
  'init',
  'list',
  'search',
  'install',
  'run',
  'resume',
  'runs',
  'upgrade',
  'doctor',
  'new',
  'publish',
  'test',
  'logs',
  'config',
  'validate',
  'dry-run',
  'help',
]);

/**
 * Determine whether an argument could be a flow name or path shorthand.
 * A flow name has no leading '-' (not a flag) and is not empty.
 */
function looksLikeFlowRef(arg: string): boolean {
  return arg.length > 0 && !arg.startsWith('-');
}

// Static map so esbuild can analyze each path and emit them as lazy split-chunks.
// A template-literal import(`./commands/${name}.js`) would be transformed into an
// empty __glob({}) map by the bundler, breaking runtime dispatch.
const COMMAND_LOADERS: Record<
  string,
  () => Promise<{ default: (args: unknown[], opts: unknown) => Promise<void> }>
> = {
  answer: () => import('./commands/answer.js'),
  init: () => import('./commands/init.js'),
  list: () => import('./commands/list.js'),
  search: () => import('./commands/search.js'),
  install: () => import('./commands/install.js'),
  run: () => import('./commands/run.js'),
  resume: () => import('./commands/resume.js'),
  runs: () => import('./commands/runs.js'),
  upgrade: () => import('./commands/upgrade.js'),
  doctor: () => import('./commands/doctor.js'),
  new: () => import('./commands/new.js'),
  publish: () => import('./commands/publish.js'),
  test: () => import('./commands/test.js'),
  logs: () => import('./commands/logs.js'),
  glossary: () => import('./commands/glossary.js'),
  config: () => import('./commands/config.js'),
  validate: () => import('./commands/validate.js'),
  'dry-run': () => import('./commands/dry-run.js'),
};

async function loadCommand(
  name: string,
): Promise<(args: unknown[], opts: unknown) => Promise<void>> {
  const loader = COMMAND_LOADERS[name];
  if (!loader) throw new Error(`Unknown command: ${name}`);
  const mod = await loader();
  return mod.default;
}

/**
 * Build and return the top-level Commander program.
 * The caller invokes `.parseAsync(argv)` on the returned Command.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('relay')
    .description('Claude pipelines you can run twice')
    .allowUnknownOption(false)
    // Allow positional arguments so the root action receives them for the
    // flow-shorthand path and the near-miss typo check. Without this,
    // Commander's _excessArguments() fires before the action body is entered
    // and the positional is never inspected.
    .allowExcessArguments(true)
    // Global options
    .option('--verbose', 'print debug-level output')
    .option('--run-dir <path>', 'override the run directory (.relay/runs by default)')
    .option('--no-color', 'disable color output (also honoured via NO_COLOR env)');

  // Throw CommanderError instead of calling process.exit so the main try/catch
  // can format unknown-command errors consistently.
  program.exitOverride();

  // Enable Levenshtein-based did-you-mean suggestions for mistyped commands.
  program.showSuggestionAfterError(true);

  // Initialize color once, after Commander has parsed global flags, before any
  // command action runs. initColor() applies all precedence rules (--no-color
  // flag, NO_COLOR env, settings.json color key, TTY auto-detect).
  //
  // Commander's --no-color option is negated-boolean: opts.color is false when
  // --no-color was passed, true otherwise. We pass noColor: !opts.color so that
  // initColor() receives the correct boolean regardless of env or settings.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = program.opts<{ color: boolean; verbose?: boolean; runDir?: string }>();
    initColor({ noColor: !opts.color });
    // actionCommand is provided by commander's hook signature and intentionally unused here.
    void actionCommand;
  });

  // ------------------------------------------------------------------ init --
  program
    .command('init')
    .description('choose a provider and write ~/.relay/settings.json')
    .option('--provider <name>', 'provider to use (skips the interactive menu)')
    .option('--force', 'overwrite existing settings without prompting')
    .action(async (cmdOpts: { provider?: string; force?: boolean }) => {
      const handler = await loadCommand('init');
      await handler([], { ...program.opts(), ...cmdOpts });
    });

  // ------------------------------------------------------------------ list --
  program
    .command('list')
    .description('flows installed in this project')
    .action(async () => {
      const handler = await loadCommand('list');
      await handler([], program.opts());
    });

  // --------------------------------------------------------------- search --
  program
    .command('search <query>')
    .description('find flows in the public catalog')
    .action(async (query: string) => {
      const handler = await loadCommand('search');
      await handler([query], program.opts());
    });

  // -------------------------------------------------------------- install --
  program
    .command('install <flow>')
    .description('add a flow to this project')
    .action(async (flow: string) => {
      const handler = await loadCommand('install');
      await handler([flow], program.opts());
    });

  // ------------------------------------------------------------------ run --
  program
    .command('run <flow> [input...]')
    .description('run a flow')
    .allowUnknownOption(true)
    .option('--provider <name>', 'provider to use (overrides settings)')
    .option('--fresh', 'start a new run, ignoring any cached state')
    .option('--no-worktree', 'disable per-run git worktree isolation')
    .action(
      async (
        flow: string,
        input: string[],
        cmdOpts: { provider?: string; fresh?: boolean; worktree?: boolean },
      ) => {
        const handler = await loadCommand('run');
        await handler([flow, ...input], { ...program.opts(), ...cmdOpts });
      },
    );

  // -------------------------------------------------------------- resume --
  program
    .command('resume <runId>')
    .description('continue a failed or stopped run')
    .option('--provider <name>', 'provider to use (overrides settings)')
    .option('--no-worktree', 'disable per-run git worktree isolation')
    .action(async (runId: string, cmdOpts: { provider?: string; worktree?: boolean }) => {
      const handler = await loadCommand('resume');
      await handler([runId], { ...program.opts(), ...cmdOpts });
    });

  // --------------------------------------------------------------- answer --
  program
    .command('answer <runId>')
    .description('provide answers for a paused run and resume it')
    .option('--json <jsonString>', 'answers as a JSON object string (non-interactive)')
    .action(async (runId: string, cmdOpts: { json?: string }) => {
      const handler = await loadCommand('answer');
      await handler([runId], { ...program.opts(), ...cmdOpts });
    });

  // ----------------------------------------------------------------- runs --
  program
    .command('runs')
    .description('recent runs in this directory')
    .action(async () => {
      const handler = await loadCommand('runs');
      await handler([], program.opts());
    });

  // -------------------------------------------------------------- upgrade --
  program
    .command('upgrade [flow]')
    .description('fetch the latest version of one or all installed flows')
    .action(async (flow: string | undefined) => {
      const handler = await loadCommand('upgrade');
      await handler(flow !== undefined ? [flow] : [], program.opts());
    });

  // --------------------------------------------------------------- doctor --
  program
    .command('doctor')
    .description('check your environment before running')
    .option('--provider <name>', 'pre-flight a specific provider (overrides settings)')
    .action(async (cmdOpts: { provider?: string }) => {
      const handler = await loadCommand('doctor');
      await handler([], { ...program.opts(), ...cmdOpts });
    });

  // ------------------------------------------------------------------ new --
  program
    .command('new <name>')
    .description('scaffold a new flow')
    .option('--template <name>', 'template to use (blank|linear|fan-out|discovery|loop)', undefined)
    .option('--force', 'overwrite existing directory')
    .action(async (name: string, cmdOpts: { template?: string; force?: boolean }) => {
      const handler = await loadCommand('new');
      await handler([name], { ...program.opts(), ...cmdOpts });
    });

  // -------------------------------------------------------------- publish --
  program
    .command('publish <path>')
    .description('lint and publish a flow to npm')
    .option('--dry-run', 'lint and build but skip the actual npm publish')
    .action(async (path: string, cmdOpts: { dryRun?: boolean }) => {
      const handler = await loadCommand('publish');
      await handler([path], { ...program.opts(), ...cmdOpts });
    });

  // ----------------------------------------------------------------- test --
  program
    .command('test <path>')
    .description("run a flow's snapshot tests")
    .action(async (path: string) => {
      const handler = await loadCommand('test');
      await handler([path], program.opts());
    });

  // ----------------------------------------------------------------- logs --
  program
    .command('logs <runId>')
    .description('structured run log')
    .option('--step <id>', 'filter to a specific step')
    .option('-f, --follow', 'tail the log stream')
    .option('--level <lvl>', 'minimum log level (debug|info|warn|error)')
    .option('--verbose', 'replay the full event stream from events/*.jsonl')
    .action(
      async (
        runId: string,
        cmdOpts: { step?: string; follow?: boolean; level?: string; verbose?: boolean },
      ) => {
        const handler = await loadCommand('logs');
        await handler([runId], { ...program.opts(), ...cmdOpts });
      },
    );

  // -------------------------------------------------------------- config --
  const configCmd = program
    .command('config')
    .description('view or edit Relay configuration (get <key> | set <key> <value> | list)')
    .action(async () => {
      const { default: configCommand } = (await import('./commands/config.js')) as {
        default: () => Promise<void>;
      };
      await configCommand();
    });

  configCmd
    .command('list')
    .description('print all settings')
    .action(async () => {
      const { listAction } = (await import('./commands/config.js')) as {
        listAction: (opts: Record<string, unknown>) => Promise<void>;
      };
      await listAction({ ...program.opts() });
    });

  configCmd
    .command('get <key>')
    .description('print the value of one setting')
    .action(async (key: string) => {
      const { getAction } = (await import('./commands/config.js')) as {
        getAction: (key: string, opts: Record<string, unknown>) => Promise<void>;
      };
      await getAction(key, { ...program.opts() });
    });

  configCmd
    .command('set <key> <value>')
    .description('write one setting atomically')
    .action(async (key: string, value: string) => {
      const { setAction } = (await import('./commands/config.js')) as {
        setAction: (key: string, value: string, opts: Record<string, unknown>) => Promise<void>;
      };
      await setAction(key, value, { ...program.opts() });
    });

  // ------------------------------------------------------------- validate --
  program
    .command('validate <flow>')
    .description('load a flow and validate its step graph')
    .action(async (flow: string) => {
      const handler = await loadCommand('validate');
      await handler([flow], program.opts());
    });

  // ------------------------------------------------------------- dry-run --
  program
    .command('dry-run <flow> [input...]')
    .description('validate a flow and preview what each step will do')
    .allowUnknownOption(true)
    .action(async (flow: string, input: string[]) => {
      const handler = await loadCommand('dry-run');
      await handler([flow, ...input], program.opts());
    });

  // ----------------------------------------------------------------- help --
  const helpCmd = program.command('help').description('learn about relay commands and concepts');

  helpCmd
    .command('glossary')
    .description('print the relay terminology glossary')
    .action(async () => {
      const handler = await loadCommand('glossary');
      await handler([], program.opts());
    });

  // -------------------------------------------------------- Default action --
  // When no subcommand is provided and the first positional is not a known
  // command name, silently re-route to `run` if it looks like a flow ref or
  // path (the `relay <flow> [input]` shorthand form).
  //
  // Before that fallthrough, check whether the positional looks like a
  // near-miss subcommand typo and surface a suggestion. Commander's own
  // suggestSimilar() code is not invoked at root level when an .action()
  // handler is registered — the argument reaches _processArguments() rather
  // than unknownCommand(), so we do the check ourselves here.
  program.action(async () => {
    const rawArgs = program.args;

    if (rawArgs.length > 0) {
      const first = rawArgs[0];
      if (first !== undefined && !KNOWN_COMMANDS.has(first) && !looksLikePath(first)) {
        // Find the closest registered subcommand name by Levenshtein distance.
        const subcommandNames = program.commands
          .map((c) => c.name())
          .filter((n) => n !== 'help' && n !== '');
        let closest = '';
        let minDist = Infinity;
        for (const name of subcommandNames) {
          const d = levenshtein(first, name);
          if (d < minDist) {
            minDist = d;
            closest = name;
          }
        }
        // Threshold of 2 catches single-char transpositions and deletions
        // (e.g. "rsume", "reusme") without false-positives on legitimate
        // short flow names.
        if (minDist <= 2 && closest !== '') {
          process.stderr.write(`error: unknown command '${first}'. Did you mean '${closest}'?\n`);
          process.exit(1);
        }
      }

      if (
        first !== undefined &&
        !KNOWN_COMMANDS.has(first) &&
        (looksLikePath(first) || looksLikeFlowRef(first))
      ) {
        // Re-route to the run command handler.
        const handler = await loadCommand('run');
        await handler(rawArgs, program.opts());
        return;
      }
    }

    // No subcommand, no shorthand match — show splash help.
    const { renderSplash } = await import('./help.js');
    renderSplash();
  });

  return program;
}
