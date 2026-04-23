import { Command } from 'commander';
import { looksLikePath } from './util/path.js';
import { setColorDisabled } from './visual.js';

// All v1 command names — used for shorthand routing (first-positional bypass).
const KNOWN_COMMANDS = new Set([
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
  'help',
]);

/**
 * Determine whether an argument could be a flow name or path shorthand.
 * A flow name has no leading '-' (not a flag) and is not empty.
 */
function looksLikeFlowRef(arg: string): boolean {
  return arg.length > 0 && !arg.startsWith('-');
}

/**
 * Dynamically import a command handler module from `./commands/<name>.js`.
 * Real handlers are wired in later sprints; the directory holds stubs until then.
 */
async function loadCommand(
  name: string,
): Promise<(args: unknown[], opts: unknown) => Promise<void>> {
  const mod = (await import(`./commands/${name}.js`)) as {
    default: (args: unknown[], opts: unknown) => Promise<void>;
  };
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
    // Global options
    .option('--verbose', 'print debug-level output')
    .option('--run-dir <path>', 'override the run directory (.relay/runs by default)')
    .option('--no-color', 'disable color output (also honoured via NO_COLOR env)');

  // Throw CommanderError instead of calling process.exit so the main try/catch
  // can format unknown-command errors consistently.
  program.exitOverride();

  // Apply --no-color early, before any command action runs.
  // Calls setColorDisabled() directly rather than mutating process.env — chalk.level
  // is set once at module load and env mutations after that point have no effect.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = program.opts<{ color: boolean; verbose?: boolean; runDir?: string }>();
    if (!opts.color || process.env['NO_COLOR'] !== undefined) {
      setColorDisabled();
    }
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
    .option('--template <name>', 'template to use (blank|linear|fan-out|discovery)', undefined)
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
    .action(async (runId: string, cmdOpts: { step?: string; follow?: boolean; level?: string }) => {
      const handler = await loadCommand('logs');
      await handler([runId], { ...program.opts(), ...cmdOpts });
    });

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
        listAction: () => Promise<void>;
      };
      await listAction();
    });

  configCmd
    .command('get <key>')
    .description('print the value of one setting')
    .action(async (key: string) => {
      const { getAction } = (await import('./commands/config.js')) as {
        getAction: (key: string) => Promise<void>;
      };
      await getAction(key);
    });

  configCmd
    .command('set <key> <value>')
    .description('write one setting atomically')
    .action(async (key: string, value: string) => {
      const { setAction } = (await import('./commands/config.js')) as {
        setAction: (key: string, value: string) => Promise<void>;
      };
      await setAction(key, value);
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
  program.action(async () => {
    const rawArgs = program.args;

    if (rawArgs.length > 0) {
      const first = rawArgs[0];
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
