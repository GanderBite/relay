import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { PipelineError } from '@relay/core';
import { buildProgram } from './dispatcher.js';

// Stub until task_77 provides the real constant from visual.ts.
const MARK = '●─▶●─▶●─▶●';

// Indent for §6.10 continuation lines: mark.length (10) + 1 space = 11 chars.
const VERSION_INDENT = ' '.repeat(MARK.length + 1);

function resolveVersion(pkg: string): string {
  try {
    const req = createRequire(import.meta.url);
    const meta: unknown = req(`${pkg}/package.json`);
    if (
      meta !== null &&
      typeof meta === 'object' &&
      'version' in meta &&
      typeof (meta as Record<string, unknown>)['version'] === 'string'
    ) {
      return (meta as Record<string, unknown>)['version'] as string;
    }
    return 'unknown';
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
  const cliVer = resolveVersion('@relay/cli');
  const coreVer = resolveVersion('@relay/core');
  const nodeVer = process.version.replace(/^v/, '');
  const claudeVer = resolveClaudeVersion();

  // §6.10 — four lines, verbatim format:
  //   ●─▶●─▶●─▶●  relay <ver>
  //              @relay/cli <ver>
  //              @relay/core <ver>
  //              node <ver> · claude <ver>
  process.stdout.write(
    [
      `${MARK}  relay ${cliVer}`,
      `${VERSION_INDENT}@relay/cli ${cliVer}`,
      `${VERSION_INDENT}@relay/core ${coreVer}`,
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

  const program = buildProgram();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof PipelineError) {
      // Placeholder: task_46 will wire the real exit-code mapper in wave 2.
      process.stderr.write(`${err.name}: ${err.message}\n`);
      process.exit(1);
    }
    // Non-PipelineError — surface the stack so nothing is silently swallowed.
    if (err instanceof Error) {
      process.stderr.write(`${err.stack ?? err.message}\n`);
    } else {
      process.stderr.write(String(err) + '\n');
    }
    process.exit(1);
  }
}
