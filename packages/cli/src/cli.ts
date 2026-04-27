import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { z } from 'zod';
import { MARK } from './brand.js';
import { buildProgram } from './dispatcher.js';
import { exitCodeFor, formatError } from './exit-codes.js';
import { renderSplash } from './help.js';

export type { RegistryDoc, RegistryEntry, RegistryError } from './registry.js';
// Public API re-exports — consumed by bin shims and catalog tooling.
export { generateRegistryJson } from './registry.js';

// Indent for --version continuation lines: mark.length (11) + 1 space = 12 chars.
const VERSION_INDENT = ' '.repeat(MARK.length + 1);

// Read version from the package.json sitting one level above dist/cli.js.
// createRequire('@ganderbite/relay/package.json') cannot resolve the package by
// its own scoped name from within its own dist directory.
function resolveVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const meta: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const parsed = z.object({ version: z.string() }).passthrough().safeParse(meta);
    return parsed.success ? parsed.data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveClaudeVersion(): string {
  try {
    const out = execSync('claude --version 2>/dev/null', { timeout: 3000 }).toString().trim();
    // "claude 2.4.1" or "2.4.1" — extract the semver token
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(out);
    return match?.[1] ?? out;
  } catch {
    return 'unknown';
  }
}

function printVersion(): void {
  const cliVer = resolveVersion();
  // relay-core is bundled inline — its version always matches the CLI.
  const coreVer = cliVer;
  const nodeVer = process.version.replace(/^v/, '');
  const claudeVer = resolveClaudeVersion();

  // --version — four lines:
  //   ●─▶●─▶●─▶●  relay <ver>
  //              @ganderbite/relay <ver>
  //              @ganderbite/relay-core <ver>
  //              node <ver> · claude <ver>
  process.stdout.write(
    [
      `${MARK}  relay ${cliVer}`,
      `${VERSION_INDENT}@ganderbite/relay ${cliVer}`,
      `${VERSION_INDENT}@ganderbite/relay-core ${coreVer}`,
      `${VERSION_INDENT}node ${nodeVer} · claude ${claudeVer}`,
    ].join('\n') + '\n',
  );
}

export async function main(argv: string[]): Promise<void> {
  // Top-level --version short-circuit before commander processes argv.
  if (argv.includes('--version') || argv.includes('-V')) {
    printVersion();
    process.exit(0);
  }

  // Bare `relay` (no args) or `relay --help` with no subcommand → splash.
  // `relay <subcommand> --help` still reaches Commander for per-command help.
  const extraArgs = argv.slice(2).filter((a) => a !== '--no-color' && a !== '--verbose');
  const isBareSplash =
    extraArgs.length === 0 || (extraArgs.length === 1 && extraArgs[0] === '--help');
  if (isBareSplash) {
    renderSplash();
    process.exit(0);
  }

  const program = buildProgram();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) {
      // Commander printed help or version — normal exit, not an error.
      process.exit(0);
    }
    process.stderr.write(formatError(err) + '\n');
    process.exit(exitCodeFor(err));
  }
}
