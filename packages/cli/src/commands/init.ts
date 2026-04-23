/**
 * relay init — probe auth for claude-cli and write ~/.relay/settings.json.
 *
 * Prints a one-line header confirming the only available provider
 * (claude-cli · subscription billing), probes auth via ClaudeCliProvider,
 * handles the not-logged-in path (offer `claude /login`), and writes
 * ~/.relay/settings.json with { "provider": "claude-cli" }.
 *
 * Overwrite guard: prompts before replacing an existing settings file with a
 * different provider value (skip with --force in non-interactive mode).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';

import {
  atomicWriteJson,
  ClaudeAuthError,
  ClaudeCliProvider,
  globalSettingsPath,
  loadGlobalSettings,
} from '@relay/core';

import { MARK, SYMBOLS } from '../brand.js';
import { gray, green } from '../color.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PROVIDERS = ['claude-cli'] as const;
type ValidProvider = (typeof VALID_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Public command interface
// ---------------------------------------------------------------------------

export interface InitCommandOptions {
  provider?: string;
  force?: boolean;
}

/**
 * Entry point for `relay init`.
 */
export default async function initCommand(_args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as InitCommandOptions;

  // Header — always print regardless of interactive/non-interactive mode.
  process.stdout.write(`${MARK}  relay init\n`);
  process.stdout.write('\n');

  // ---- Resolve provider name ----
  let providerName: ValidProvider;

  if (options.provider !== undefined) {
    // Non-interactive: validate the flag value.
    if (!isValidProvider(options.provider)) {
      process.stderr.write(
        `unknown provider: ${options.provider}\n` +
          `valid providers: ${VALID_PROVIDERS.join(', ')}\n`,
      );
      process.exit(1);
    }
    providerName = options.provider as ValidProvider;
  } else {
    // Only one provider is available — confirm it and proceed.
    process.stdout.write('provider  claude-cli · subscription billing\n');
    process.stdout.write('\n');
    providerName = 'claude-cli';
  }

  // ---- Check existing settings ----
  const settingsPath = globalSettingsPath();
  const existingResult = await loadGlobalSettings();

  if (existingResult.isOk() && existingResult.value !== null) {
    const existing = existingResult.value;
    if (existing.provider !== undefined && existing.provider !== providerName) {
      if (options.force === true) {
        // --force skips the prompt in non-interactive mode.
      } else if (options.provider !== undefined) {
        // Non-interactive without --force: block overwrite.
        process.stderr.write(
          `~/.relay/settings.json already configures provider: ${existing.provider}\n` +
            `pass --force to overwrite\n`,
        );
        process.exit(1);
      } else {
        // Interactive: prompt.
        const answer = await prompt(
          `~/.relay/settings.json already configures provider: ${existing.provider}\noverwrite? [y/N]: `,
        );
        if (answer.toLowerCase() !== 'y') {
          process.stdout.write(gray('→ keeping existing settings') + '\n');
          process.exit(0);
        }
      }
    }
  }

  // ---- Probe auth ----
  await handleClaudeCliAuth(settingsPath, providerName);
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function handleClaudeCliAuth(
  settingsPath: string,
  providerName: ValidProvider,
): Promise<void> {
  const provider = new ClaudeCliProvider();
  const authResult = await provider.authenticate();

  if (authResult.isOk()) {
    // Auth OK — write settings and exit 0.
    await writeSettings(settingsPath, providerName);
    return;
  }

  const authErr = authResult.error;

  // Auth failed — print error message.
  process.stderr.write(authErr.message + '\n');
  process.stderr.write('\n');

  // Offer to spawn `claude /login` if the error is a ClaudeAuthError
  // (not logged in). For other error types, just exit.
  if (!(authErr instanceof ClaudeAuthError)) {
    process.exit(3);
  }

  const loginAnswer = await prompt('run `claude /login` now? [Y/n]: ');
  const doLogin = loginAnswer.trim() === '' || loginAnswer.trim().toLowerCase() === 'y';

  if (!doLogin) {
    process.stdout.write('→ run `claude /login` when ready, then re-run `relay init`\n');
    process.exit(1);
  }

  // Spawn `claude /login` attached to the parent TTY.
  const loginExitCode = await spawnAttached('claude', ['/login']);

  if (loginExitCode !== 0) {
    process.stderr.write(`claude /login exited with code ${loginExitCode}\n`);
    process.stderr.write('→ run `claude /login` when ready, then re-run `relay init`\n');
    process.exit(1);
  }

  // Re-probe after successful login.
  const reProbeResult = await provider.authenticate();

  if (reProbeResult.isErr()) {
    process.stderr.write(reProbeResult.error.message + '\n');
    process.stderr.write('→ run `claude /login` when ready, then re-run `relay init`\n');
    process.exit(3);
  }

  // Re-probe succeeded — write settings.
  process.stdout.write(green(`${SYMBOLS.ok} authenticated`) + '\n');
  await writeSettings(settingsPath, providerName);
}

// ---------------------------------------------------------------------------
// Write settings
// ---------------------------------------------------------------------------

async function writeSettings(settingsPath: string, providerName: ValidProvider): Promise<void> {
  // Ensure ~/.relay/ exists.
  const relayDir = settingsPath.replace(/\/settings\.json$/, '');
  await fs.mkdir(relayDir, { recursive: true });

  const writeResult = await atomicWriteJson(settingsPath, { provider: providerName });
  if (writeResult.isErr()) {
    process.stderr.write(`failed to write settings: ${writeResult.error.message}\n`);
    process.exit(1);
  }

  process.stdout.write(green(`${SYMBOLS.ok} wrote ~/.relay/settings.json`) + '\n');
  process.stdout.write('→ next: relay doctor\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidProvider(name: string): name is ValidProvider {
  return (VALID_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Prompt the user for input via readline.
 * Resolves with the trimmed line (or empty string on EOF/SIGINT).
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Clean exit on SIGINT during prompt.
    rl.once('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      process.exit(130);
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer ?? '');
    });
  });
}

/**
 * Spawn a command with stdio inherited from the parent process (attached to the
 * TTY). Returns the exit code (or 1 on signal termination).
 */
function spawnAttached(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else if (signal !== null) {
        resolve(1);
      } else {
        resolve(0);
      }
    });
    child.on('error', () => {
      resolve(1);
    });
  });
}
