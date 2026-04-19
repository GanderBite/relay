/**
 * relay doctor — environment pre-flight check.
 *
 * Checks five things before any flow is run:
 *   1. node version  (≥ 20.10.0 required)
 *   2. claude binary (version + path)
 *   3. auth          (billing source via ClaudeProvider)
 *   4. env           (ANTHROPIC_API_KEY safety guard)
 *   5. dir           (.relay directory writable)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — non-billing-safety blockers present
 *   3 — ANTHROPIC_API_KEY billing-safety guard triggered (ClaudeAuthError code)
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { ClaudeProvider } from '@relay/core';
import { MARK, SYMBOLS, green, red, yellow } from '../visual.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Width of the label column (padEnd to this value before the value column). */
const LABEL_WIDTH = 13;

/** Prefix for every check row: space + symbol + space. */
const PREFIX_WIDTH = 3; // ' ✓ ' or ' ✕ '

/** Total width to value column start = PREFIX_WIDTH + LABEL_WIDTH. */
const VALUE_INDENT = PREFIX_WIDTH + LABEL_WIDTH; // 16

/** Extra indent for continuation lines within a row's value block. */
const CONTINUATION_EXTRA = 2;

/** Full indent for continuation and remediation lines. */
const CONTINUATION_INDENT = ' '.repeat(VALUE_INDENT + CONTINUATION_EXTRA); // 18 spaces

// ---------------------------------------------------------------------------
// Row renderer
// ---------------------------------------------------------------------------

function okRow(label: string, value: string): string {
  return green(` ${SYMBOLS.ok} ${label.padEnd(LABEL_WIDTH)}${value}`);
}

function failRow(label: string, value: string): string {
  return red(` ${SYMBOLS.fail} ${label.padEnd(LABEL_WIDTH)}${value}`);
}

// ---------------------------------------------------------------------------
// Semver comparison (no external dep — only used for node version check)
// ---------------------------------------------------------------------------

/**
 * Returns true if versionA >= versionB.
 * Parses simple "major.minor.patch" semver strings.
 */
function semverGte(versionA: string, versionB: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [aMaj, aMin, aPatch] = parse(versionA);
  const [bMaj, bMin, bPatch] = parse(versionB);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch >= bPatch;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

interface CheckResult {
  line: string;
  blocked: boolean;
  isApiKeyBlocker: boolean;
}

/** 1. node version */
function checkNode(): CheckResult {
  const version = process.versions.node;
  const required = '20.10.0';
  const ok = semverGte(version, required);
  return {
    line: ok
      ? okRow('node', `${version}  (≥ ${required} required)`)
      : failRow('node', `${version}  (≥ ${required} required)`),
    blocked: !ok,
    isApiKeyBlocker: false,
  };
}

/** 2. claude binary — version + path */
async function checkClaude(): Promise<CheckResult> {
  try {
    // Get the version string
    const versionResult = await execFileAsync('claude', ['--version'], {
      timeout: 5_000,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    const versionOutput = versionResult.stdout.trim() || versionResult.stderr.trim();
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(versionOutput);
    const version = match?.[1] ?? versionOutput;

    // Get the binary path
    let binaryPath = 'unknown path';
    try {
      const whichResult = await execFileAsync('which', ['claude'], {
        timeout: 2_000,
        env: { PATH: process.env['PATH'] ?? '' },
      });
      const resolved = whichResult.stdout.trim();
      if (resolved.length > 0) binaryPath = resolved;
    } catch {
      // which failed — leave as 'unknown path'
    }

    return {
      line: okRow('claude', `${version} at ${binaryPath}`),
      blocked: false,
      isApiKeyBlocker: false,
    };
  } catch {
    return {
      line: failRow('claude', "not found — install from https://claude.com/code/install"),
      blocked: true,
      isApiKeyBlocker: false,
    };
  }
}

/**
 * Format an AuthState into the doctor auth row value.
 *
 * The product spec shows: `subscription (max) via CLAUDE_CODE_OAUTH_TOKEN`.
 * We construct this from billingSource + the env var or detail.
 */
function formatAuthValue(billingSource: string, detail: string): string {
  // subscription billing — always shown as "subscription (max) via <source>"
  if (billingSource === 'subscription') {
    if (detail.includes('CLAUDE_CODE_OAUTH_TOKEN')) {
      return 'subscription (max) via CLAUDE_CODE_OAUTH_TOKEN';
    }
    if (detail.includes('interactive')) {
      return 'subscription (max) via interactive credentials';
    }
    return `subscription (max) via ${detail}`;
  }

  // API-account (opted in explicitly)
  if (billingSource === 'api-account') {
    return `api account ${yellow('(billing applies)')}`;
  }

  // Cloud routing
  if (billingSource === 'bedrock') return `bedrock ${detail}`;
  if (billingSource === 'vertex') return `vertex ${detail}`;
  if (billingSource === 'foundry') return `foundry ${detail}`;

  return detail;
}

/** 3. auth check */
async function checkAuth(): Promise<CheckResult> {
  // Use allowApiKey: true so we can display what auth would be regardless
  // of whether ANTHROPIC_API_KEY is present. The env check below handles
  // the billing-safety guard separately.
  const provider = new ClaudeProvider({ allowApiKey: true });
  const result = await provider.authenticate();

  if (result.isErr()) {
    const msg = result.error.message;
    return {
      line: failRow('auth', msg),
      blocked: true,
      isApiKeyBlocker: false,
    };
  }

  const state = result.value;
  const value = formatAuthValue(state.billingSource, state.detail);
  return {
    line: okRow('auth', value),
    blocked: false,
    isApiKeyBlocker: false,
  };
}

/** 4. env check — ANTHROPIC_API_KEY billing-safety guard */
function checkEnv(): CheckResult {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const isSet = typeof apiKey === 'string' && apiKey.length > 0;

  if (!isSet) {
    return {
      line: okRow('env', 'no conflicting ANTHROPIC_API_KEY'),
      blocked: false,
      isApiKeyBlocker: false,
    };
  }

  // Blocking case — verbatim remediation block from product spec §6.2
  const labelPad = 'env'.padEnd(LABEL_WIDTH);
  const lines = [
    red(` ${SYMBOLS.fail} ${labelPad}ANTHROPIC_API_KEY is set in your environment`),
    `${CONTINUATION_INDENT}running a flow now would bill your API account,`,
    `${CONTINUATION_INDENT}not your Max subscription.`,
    '',
    `${CONTINUATION_INDENT}fix:      unset ANTHROPIC_API_KEY`,
    `${CONTINUATION_INDENT}permanent: remove the line from ~/.zshrc`,
    `${CONTINUATION_INDENT}override: relay run --api-key (opts into API billing)`,
  ];

  return {
    line: lines.join('\n'),
    blocked: true,
    isApiKeyBlocker: true,
  };
}

/** 5. dir check — .relay directory writable */
async function checkDir(): Promise<CheckResult> {
  const relayDir = path.resolve('.relay');

  try {
    // Create the directory if it does not exist.
    await fs.mkdir(relayDir, { recursive: true });
    // Verify write access.
    await fs.access(relayDir, fs.constants.W_OK);
    return {
      line: okRow('dir', './.relay writable'),
      blocked: false,
      isApiKeyBlocker: false,
    };
  } catch {
    return {
      line: failRow('dir', './.relay not writable'),
      blocked: true,
      isApiKeyBlocker: false,
    };
  }
}

// ---------------------------------------------------------------------------
// doctorCommand
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay doctor`.
 *
 * Runs all five checks, prints results, then exits with:
 *   0 — no blockers
 *   3 — ANTHROPIC_API_KEY billing-safety blocker (only/primary blocker)
 *   1 — other blockers present
 */
export default async function doctorCommand(
  _args: unknown[],
  _opts: unknown,
): Promise<void> {
  // Header
  process.stdout.write(`${MARK}  relay doctor\n\n`);

  // Run all checks
  const nodeResult = checkNode();
  const claudeResult = await checkClaude();
  const authResult = await checkAuth();
  const envResult = checkEnv();
  const dirResult = await checkDir();

  const results: CheckResult[] = [
    nodeResult,
    claudeResult,
    authResult,
    envResult,
    dirResult,
  ];

  // Emit check rows. The env row has a multi-line value with a trailing blank
  // line; all other rows are single lines. A blank line separates the env fail
  // block from the dir row — insert it after the env row only when env fails.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) continue;
    process.stdout.write(r.line + '\n');
    // When env fails, its block ends without a trailing newline — add blank
    // line before the next row so the dir row reads cleanly.
    if (i === 3 && r.blocked) {
      process.stdout.write('\n');
    }
  }

  // Blank line before summary
  process.stdout.write('\n');

  // Count blockers
  const blockers = results.filter((r) => r.blocked);
  const blockerCount = blockers.length;

  // Summary line
  if (blockerCount === 0) {
    process.stdout.write(green('ready to run.') + '\n');
    process.exit(0);
  }

  const summary =
    blockerCount === 1
      ? red('1 blocker before you can run.')
      : red(`${blockerCount} blockers before you can run.`);
  process.stdout.write(summary + '\n');

  // Exit code 3 when the ANTHROPIC_API_KEY guard is the sole blocker.
  // Exit code 1 for any other combination of blockers.
  const onlyApiKeyBlocker =
    blockerCount === 1 && (blockers[0]?.isApiKeyBlocker === true);
  process.exit(onlyApiKeyBlocker ? 3 : 1);
}
