/**
 * relay doctor — environment pre-flight check.
 *
 * Sections:
 *   1. node version  (≥ 20.10.0 required)
 *   2. claude binary (version + path)
 *   3. env           (ANTHROPIC_API_KEY safety guard)
 *   4. dir           (.relay directory writable)
 *   5. providers     (one row per registered provider with billing descriptor)
 *   6. auth          (per-provider authenticate() probe)
 *   7. resolver      (resolveProvider against current settings + env)
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

import {
  defaultRegistry,
  loadFlowSettings,
  loadGlobalSettings,
  NoProviderConfiguredError,
  ProviderRegistry,
  registerDefaultProviders,
  resolveProvider,
  type Provider,
  type RelaySettingsType,
} from '@relay/core';
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

/** Provider-name column width inside the providers/auth blocks. */
const PROVIDER_NAME_WIDTH = 20;

/** Middle dot separator (U+00B7). The brand grammar mandates this exact glyph. */
const DOT = SYMBOLS.dot;

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

/** 3. env check — ANTHROPIC_API_KEY billing-safety guard */
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

/** 4. dir check — .relay directory writable */
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
// Provider blocks — providers / auth / resolver
//
// `registerDefaultProviders` is idempotent and registers BOTH the
// subscription-safe `claude-cli` provider AND the API-account-billed
// `claude-agent-sdk` provider. The doctor reports both rows so the user can
// see at a glance which billing surface each backend would hit before they
// commit to one via `relay init` or `--provider`.
// ---------------------------------------------------------------------------

/**
 * Static billing descriptor for each known provider name. Subscription-safe
 * providers are surfaced in green; API-account billing is surfaced in yellow
 * to flag the cost surface before the user commits.
 */
function billingDescriptor(name: string): { text: string; color: 'green' | 'yellow' | 'none' } {
  if (name === 'claude-cli') return { text: 'subscription-safe', color: 'green' };
  if (name === 'claude-agent-sdk') return { text: 'API-account billing', color: 'yellow' };
  return { text: 'unknown billing surface', color: 'none' };
}

function colorize(text: string, color: 'green' | 'yellow' | 'none'): string {
  if (color === 'green') return green(text);
  if (color === 'yellow') return yellow(text);
  return text;
}

/** Format one provider row inside the providers block. */
function providerLine(provider: Provider): string {
  const desc = billingDescriptor(provider.name);
  const name = provider.name.padEnd(PROVIDER_NAME_WIDTH);
  return `  ${name}${DOT} ${colorize(desc.text, desc.color)}`;
}

/**
 * Run authenticate() against one provider and render the result row.
 * Subscription-billed providers print green; API-account billing prints
 * yellow; failures print red with the inspector's remediation message.
 */
async function authProbeRow(provider: Provider): Promise<CheckResult> {
  const result = await provider.authenticate();
  const name = provider.name.padEnd(PROVIDER_NAME_WIDTH);

  if (result.isErr()) {
    return {
      line: red(`  ${SYMBOLS.fail} ${name}${DOT} ${result.error.message}`),
      blocked: true,
      isApiKeyBlocker: false,
    };
  }

  const state = result.value;
  let summary: string;
  let color: 'green' | 'yellow' | 'none' = 'none';
  if (state.billingSource === 'subscription') {
    summary = 'subscription ready';
    color = 'green';
  } else if (state.billingSource === 'api-account') {
    summary = 'API-account ready';
    color = 'yellow';
  } else {
    summary = `${state.billingSource} ready`;
    color = 'green';
  }
  return {
    line: `  ${green(SYMBOLS.ok)} ${name}${DOT} ${colorize(summary, color)}`,
    blocked: false,
    isApiKeyBlocker: false,
  };
}

/**
 * Decide which settings layer supplied the resolved provider name. Mirrors
 * the precedence in `resolveProvider` — flag wins, then flow settings, then
 * global settings.
 */
function resolverSource(args: {
  flagProvider: string | undefined;
  flowSettings: RelaySettingsType | null;
  globalSettings: RelaySettingsType | null;
}): 'flag' | 'flow-settings' | 'global-settings' | null {
  if (args.flagProvider !== undefined) return 'flag';
  if (args.flowSettings?.provider !== undefined) return 'flow-settings';
  if (args.globalSettings?.provider !== undefined) return 'global-settings';
  return null;
}

interface ResolverOutcome {
  lines: string[];
  blocked: boolean;
}

async function checkResolver(registry: ProviderRegistry): Promise<ResolverOutcome> {
  const flowDir = process.cwd();
  const globalResult = await loadGlobalSettings();
  const flowResult = await loadFlowSettings(flowDir);

  if (globalResult.isErr()) {
    return {
      lines: [red(`  ${SYMBOLS.fail} ${globalResult.error.message}`)],
      blocked: true,
    };
  }
  if (flowResult.isErr()) {
    return {
      lines: [red(`  ${SYMBOLS.fail} ${flowResult.error.message}`)],
      blocked: true,
    };
  }

  const resolved = resolveProvider({
    flowSettings: flowResult.value,
    globalSettings: globalResult.value,
    registry,
  });

  if (resolved.isErr()) {
    if (resolved.error instanceof NoProviderConfiguredError) {
      return {
        lines: [`  ${resolved.error.message}`],
        blocked: true,
      };
    }
    return {
      lines: [red(`  ${SYMBOLS.fail} ${resolved.error.message}`)],
      blocked: true,
    };
  }

  const provider = resolved.value;
  const source =
    resolverSource({
      flagProvider: undefined,
      flowSettings: flowResult.value,
      globalSettings: globalResult.value,
    }) ?? 'global-settings';

  return {
    lines: [
      green(`  → resolves to: ${provider.name} (${source})`),
    ],
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// doctorCommand
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay doctor`.
 *
 * Runs each section, prints results, then exits with:
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

  // Run the host-environment checks first.
  const nodeResult = checkNode();
  const claudeResult = await checkClaude();
  const envResult = checkEnv();
  const dirResult = await checkDir();

  const envChecks: CheckResult[] = [nodeResult, claudeResult, envResult, dirResult];

  // Emit check rows. The env row has a multi-line value with a trailing blank
  // line; all other rows are single lines. A blank line separates the env fail
  // block from the dir row — insert it after the env row only when env fails.
  for (let i = 0; i < envChecks.length; i++) {
    const r = envChecks[i];
    if (r === undefined) continue;
    process.stdout.write(r.line + '\n');
    if (i === 2 && r.blocked) {
      process.stdout.write('\n');
    }
  }

  // Register both Claude providers idempotently so the providers/auth/resolver
  // blocks reflect what a `relay run` would see. Custom registrations on the
  // default registry win — registerIfAbsent never overwrites.
  registerDefaultProviders(defaultRegistry);
  const providers = defaultRegistry.list();

  // -------------------------------------------------------------------------
  // providers block
  // -------------------------------------------------------------------------
  process.stdout.write('\nproviders\n\n');
  for (const provider of providers) {
    process.stdout.write(providerLine(provider) + '\n');
  }

  // -------------------------------------------------------------------------
  // auth block — per-provider authenticate() probe
  //
  // The per-provider rows are informational only. A user configured for one
  // backend will fail authenticate() on the other, which is expected — those
  // rows do not flow into the blocker tally below. The resolver block is the
  // single blocker for "can a run start right now?".
  // -------------------------------------------------------------------------
  process.stdout.write('\nauth\n\n');
  for (const provider of providers) {
    const row = await authProbeRow(provider);
    process.stdout.write(row.line + '\n');
  }

  // -------------------------------------------------------------------------
  // resolver block — what a real run would pick right now
  // -------------------------------------------------------------------------
  process.stdout.write('\nresolver\n\n');
  const resolverOutcome = await checkResolver(defaultRegistry);
  for (const line of resolverOutcome.lines) {
    process.stdout.write(line + '\n');
  }

  // Blank line before summary
  process.stdout.write('\n');

  // Aggregate blocker state. The auth block's per-provider rows do NOT block
  // — a user with only one provider configured will fail authenticate() on
  // the other, which is expected. The resolver block IS a blocker because a
  // run cannot start without a resolved provider.
  const summaryBlockers = envChecks.filter((r) => r.blocked);
  if (resolverOutcome.blocked) {
    summaryBlockers.push({
      line: '',
      blocked: true,
      isApiKeyBlocker: false,
    });
  }
  const blockerCount = summaryBlockers.length;

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
    blockerCount === 1 && (summaryBlockers[0]?.isApiKeyBlocker === true);
  process.exit(onlyApiKeyBlocker ? 3 : 1);
}
