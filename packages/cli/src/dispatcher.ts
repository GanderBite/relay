import { Command } from 'commander';
import { setColorDisabled } from './visual.js';

// All v1 command names — used for shorthand routing (first-positional bypass).
const KNOWN_COMMANDS = new Set([
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
]);

/**
 * Determine whether an argument looks like a local path.
 * Positives: starts with '.', '/', or contains '/'.
 */
function looksLikePath(arg: string): boolean {
  return arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('/') || arg.includes('/');
}

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
async function loadCommand(name: string): Promise<(args: unknown[], opts: unknown) => Promise<void>> {
  const mod = await import(`./commands/${name}.js`) as { default: (args: unknown[], opts: unknown) => Promise<void> };
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
    .action(async (flow: string, input: string[]) => {
      const handler = await loadCommand('run');
      await handler([flow, ...input], program.opts());
    });

  // -------------------------------------------------------------- resume --
  program
    .command('resume <runId>')
    .description('continue a failed or stopped run')
    .action(async (runId: string) => {
      const handler = await loadCommand('resume');
      await handler([runId], program.opts());
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
    .action(async () => {
      const handler = await loadCommand('doctor');
      await handler([], program.opts());
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
    .action(async (runId: string) => {
      const handler = await loadCommand('logs');
      await handler([runId], program.opts());
    });

  // -------------------------------------------------------------- config --
  program
    .command('config')
    .description('view or edit Relay configuration')
    .action(async () => {
      const handler = await loadCommand('config');
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

    // No subcommand, no shorthand match — placeholder until sprint 13.
    process.stdout.write('(splash help coming in sprint 13)\n');
  });

  return program;
}
