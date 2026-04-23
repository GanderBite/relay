/**
 * relay doctor — environment pre-flight check.
 *
 * Sections:
 *   1. node version  (≥ 20.10.0 required)
 *   2. claude binary (version + path)
 *   3. dir           (.relay directory writable)
 *   4. providers     (one row per registered provider with billing descriptor)
 *   5. auth          (per-provider authenticate() probe)
 *   6. resolver      (resolveProvider against current settings + env)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — blockers present
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
  type Provider,
  type ProviderRegistry,
  type RelaySettingsType,
  registerDefaultProviders,
  resolveProvider,
} from '@relay/core';
import { green, MARK, red, SYMBOLS, yellow } from '../visual.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Width of the label column (padEnd to this value before the value column). */
const LABEL_WIDTH = 13;

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
    };
  } catch {
    return {
      line: failRow('claude', 'not found — install from https://claude.com/code/install'),
      blocked: true,
    };
  }
}

/** 3. dir check — .relay directory writable */
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
    };
  } catch {
    return {
      line: failRow('dir', './.relay not writable'),
      blocked: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider blocks — providers / auth / resolver
//
// `registerDefaultProviders` is idempotent and registers the subscription-safe
// `claude-cli` provider. The providers block shows one row so the user can
// confirm the billing surface before committing via `relay init` or `--provider`.
// ---------------------------------------------------------------------------

/**
 * Static billing descriptor for each known provider name. Subscription-safe
 * providers are surfaced in green.
 */
function billingDescriptor(name: string): { text: string; color: 'green' | 'yellow' | 'none' } {
  if (name === 'claude-cli') return { text: 'subscription-safe', color: 'green' };
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

async function checkResolver(
  registry: ProviderRegistry,
  flagProvider?: string,
): Promise<ResolverOutcome> {
  const flowDir = process.cwd();
  const globalResult = await loadGlobalSettings();
  const flowSettingsResult = await loadFlowSettings(flowDir);

  if (globalResult.isErr()) {
    return {
      lines: [red(`  ${SYMBOLS.fail} ${globalResult.error.message}`)],
      blocked: true,
    };
  }
  if (flowSettingsResult.isErr()) {
    return {
      lines: [red(`  ${SYMBOLS.fail} ${flowSettingsResult.error.message}`)],
      blocked: true,
    };
  }

  const resolved = resolveProvider({
    flagProvider,
    flowSettings: flowSettingsResult.value,
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
      flagProvider,
      flowSettings: flowSettingsResult.value,
      globalSettings: globalResult.value,
    }) ?? 'global-settings';

  return {
    lines: [green(`  → resolves to: ${provider.name} (${source})`)],
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// doctorCommand
// ---------------------------------------------------------------------------

interface DoctorCommandOptions {
  provider?: string;
}

/**
 * Entry point for `relay doctor`.
 *
 * Runs each section, prints results, then exits with:
 *   0 — no blockers
 *   1 — blockers present
 */
export default async function doctorCommand(_args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as DoctorCommandOptions;

  // Header
  process.stdout.write(`${MARK}  relay doctor\n\n`);

  // Run the host-environment checks.
  const nodeResult = checkNode();
  const claudeResult = await checkClaude();
  const dirResult = await checkDir();

  const hostChecks: CheckResult[] = [nodeResult, claudeResult, dirResult];

  for (const r of hostChecks) {
    process.stdout.write(r.line + '\n');
  }

  // Register the claude-cli provider idempotently so the providers/auth/resolver
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
  // Informational only — does not flow into the blocker tally below.
  // The resolver block is the single blocker for "can a run start right now?".
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
  const resolverOutcome = await checkResolver(defaultRegistry, options.provider);
  for (const line of resolverOutcome.lines) {
    process.stdout.write(line + '\n');
  }

  // Blank line before summary
  process.stdout.write('\n');

  // Aggregate blocker state. Host checks + resolver. The auth block's
  // per-provider rows do NOT block — a user with only one provider configured
  // will fail authenticate() on the other, which is expected.
  const hostBlockers = hostChecks.filter((r) => r.blocked);
  const blockerCount = hostBlockers.length + (resolverOutcome.blocked ? 1 : 0);

  if (blockerCount === 0) {
    process.stdout.write(green('ready to run.') + '\n');
    process.exit(0);
  }

  const summary =
    blockerCount === 1
      ? red('1 blocker before you can run.')
      : red(`${blockerCount} blockers before you can run.`);
  process.stdout.write(summary + '\n');

  process.exit(1);
}
