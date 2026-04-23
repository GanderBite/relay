/**
 * `relay upgrade [flow]` — upgrade one or all installed flows to their latest
 * compatible version.
 *
 * With no argument: iterates every directory under `.relay/flows/` and
 * re-installs each flow, letting the install handler resolve the latest
 * version compatible with the original semver range in package.json.
 *
 * With a `<flow>` argument: upgrades just that one flow.
 *
 * Per-flow output: `  <name>  v<before> → v<after>` in green when the version
 * changed, gray when already at the latest version. Failed flows are printed
 * in red and do not abort the remaining upgrades.
 *
 * Output contract (product spec §6.8 banner shape):
 *
 *   ●─▶●─▶●─▶●  upgrading flows
 *
 *     codebase-discovery  v0.1.0 → v0.1.1
 *     api-audit           already at v0.2.1
 *
 *   upgrade complete. 1 updated, 1 already current.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import semver from 'semver';

import { gray, green, MARK, red, SYMBOLS } from '../visual.js';
import installCommand from './install.js';

// ---------------------------------------------------------------------------
// Package.json reader — extracts the version field only
// ---------------------------------------------------------------------------

async function readVersion(flowDir: string): Promise<string | null> {
  const pkgPath = join(flowDir, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgPath, { encoding: 'utf8' });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  return typeof p['version'] === 'string' ? p['version'] : null;
}

// ---------------------------------------------------------------------------
// Race discovery
// ---------------------------------------------------------------------------

/**
 * Return the list of race names (directory entries) under `.relay/races/`.
 * Returns null when the directory does not exist.
 */
async function discoverFlows(flowsDir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(flowsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-flow upgrade
// ---------------------------------------------------------------------------

interface UpgradeOutcome {
  name: string;
  status: 'updated' | 'current' | 'failed';
  before: string;
  after: string;
  reason?: string;
}

/**
 * Upgrade a single flow by name.
 *
 * Reads the current version, calls installCommand (which re-resolves the
 * latest compatible version from the original semver range), then reads the
 * new version to produce a before/after diff.
 */
async function upgradeFlow(name: string, flowsDir: string, opts: unknown): Promise<UpgradeOutcome> {
  const flowDir = join(flowsDir, name);

  // Read the version that is currently on disk before the install.
  const before = (await readVersion(flowDir)) ?? '0.0.0';

  try {
    await installCommand([name], opts);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    const after = (await readVersion(flowDir)) ?? before;
    return { name, status: 'failed', before, after, reason };
  }

  // Read again after install — the install handler may have written a new
  // package.json with the upgraded version.
  const after = (await readVersion(flowDir)) ?? before;
  const status = after !== before ? 'updated' : 'current';
  return { name, status, before, after };
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

/** Column width for flow name padding in the diff rows. */
const NAME_COL = 22;

/**
 * Render one flow diff row.
 *
 *   upgraded:  "  ✓  <name>  v0.1.0 → v0.1.1"   (green arrow + new ver)
 *   current:   "  ·  <name>  v0.1.0 → v0.1.0 (up to date)"  (gray)
 *   downgrade: "  ✓  <name>  v0.1.1 → v0.1.0"   (red arrow + old ver)
 *   failed:    "  ✕  <name>  failed: <reason>"   (red)
 */
function renderOutcome(outcome: UpgradeOutcome): string {
  const namePad = outcome.name.padEnd(NAME_COL);

  if (outcome.status === 'failed') {
    const reason = outcome.reason ?? 'unknown error';
    return `  ${red(SYMBOLS.fail)}  ${namePad}${red(`failed: ${reason}`)}`;
  }

  if (outcome.status === 'current') {
    return `  ${gray(SYMBOLS.dot)}  ${namePad}${gray(`v${outcome.before} → v${outcome.before} (up to date)`)}`;
  }

  // updated — compare versions to determine color
  const cmp =
    semver.valid(outcome.before) !== null && semver.valid(outcome.after) !== null
      ? semver.compare(outcome.after, outcome.before)
      : 1; // treat unparseable as upgrade

  if (cmp >= 0) {
    // upgrade (new > old) — green
    return `  ${green(SYMBOLS.ok)}  ${namePad}v${outcome.before} ${green('→')} ${green(`v${outcome.after}`)}`;
  } else {
    // downgrade (new < old) — red
    return `  ${red(SYMBOLS.ok)}  ${namePad}v${outcome.before} ${red('→')} ${red(`v${outcome.after}`)}`;
  }
}

// ---------------------------------------------------------------------------
// Public command entry point
// ---------------------------------------------------------------------------

/**
 * Entry point dispatched by the CLI for `relay upgrade [flow]`.
 *
 * @param args  Argv slice after "upgrade": optional [raceName]
 * @param opts  Parsed option flags from the dispatcher (passed through to installCommand)
 */
export default async function upgradeCommand(args: unknown[], opts: unknown): Promise<void> {
  const cwd = process.cwd();
  const flowsDir = join(cwd, '.relay', 'flows');

  const targetFlow = args[0] !== undefined ? String(args[0]) : undefined;

  // Determine which flows to upgrade.
  let flowNames: string[];

  if (targetFlow !== undefined) {
    // Single-race mode: verify the race exists before proceeding.
    const all = await discoverFlows(flowsDir);
    if (all === null || !all.includes(targetFlow)) {
      process.stdout.write(
        `  ${SYMBOLS.fail} ${targetFlow} is not installed. run: relay install ${targetFlow}\n`,
      );
      process.exit(1);
    }
    flowNames = [targetFlow];
  } else {
    // All-races mode: discover installed races.
    const discovered = await discoverFlows(flowsDir);
    if (discovered === null || discovered.length === 0) {
      process.stdout.write(`  no flows installed. try relay install.\n`);
      process.exit(0);
    }
    flowNames = discovered;
  }

  // Header — matches the banner shape from product spec §6.8.
  const verb = targetFlow !== undefined ? `upgrading ${targetFlow}` : 'upgrading flows';
  process.stdout.write(`${MARK}  ${verb}\n`);
  process.stdout.write('\n');

  // Upgrade each flow sequentially. Failures are rendered inline and do not
  // abort the remaining upgrades (collect all outcomes before the footer).
  const outcomes: UpgradeOutcome[] = [];
  for (const name of flowNames) {
    const outcome = await upgradeFlow(name, flowsDir, opts);
    process.stdout.write(renderOutcome(outcome) + '\n');
    outcomes.push(outcome);
  }

  process.stdout.write('\n');

  // Summary footer.
  const updated = outcomes.filter((o) => o.status === 'updated').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;

  process.stdout.write(`  ${updated} flow${updated === 1 ? '' : '(s)'} upgraded.\n`);
  process.stdout.write('\n');
  process.stdout.write(`  next: relay run <flow> .\n`);

  if (failed > 0) {
    process.exit(1);
  }
}
