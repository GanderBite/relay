/**
 * `relay list` — lists flows installed in this project.
 *
 * Output shape (product spec §6.8):
 *
 *   ●─▶●─▶●─▶●  installed flows (./.relay/flows/)
 *
 *    codebase-discovery    v0.1.0    20m  $0.40   PM-ready report on an unknown repo
 *    api-audit             v0.2.1    15m  $0.25   surface stale or risky HTTP routes
 *
 *   2 flows installed. search more: relay search <query>
 *
 * Sources scanned (in order, deduped by display name):
 *   1. <cwd>/.relay/flows/{name}/package.json      - local installed flows
 *   2. <cwd>/node_modules/@ganderbite/flow-{name}/package.json  - workspace flows
 *   3. https://relay.dev/registry.json              - remote catalog (5s timeout; skipped on failure)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MARK } from '../brand.js';
import { gray } from '../color.js';

// ---------------------------------------------------------------------------
// Column widths — derived from the longest entry in the spec example
// "codebase-discovery" (18 chars) → padEnd(22) gives 4 trailing spaces before "v"
// ---------------------------------------------------------------------------

const NAME_COL = 22; // display name padEnd
const VER_COL = 10; // "vX.Y.Z" padEnd
const DUR_COL = 5; // "XXm" padEnd
const COST_COL = 8; // "$X.XX" padEnd
const DESC_MAX = 60; // truncate description at this length

// ---------------------------------------------------------------------------
// Package metadata shape — the `relay` block from package.json (§7)
// ---------------------------------------------------------------------------

interface RelayMeta {
  displayName?: string;
  estimatedCostUsd?: { min: number; max: number } | number;
  estimatedDurationMin?: { min: number; max: number } | number;
  description?: string;
}

interface FlowEntry {
  /** Name shown in the table. Derived from relay.displayName, package name, or directory name. */
  displayName: string;
  version: string;
  /** Formatted cost string, e.g. "$0.40". Empty string when unknown. */
  cost: string;
  /** Formatted duration string, e.g. "20m". Empty string when unknown. */
  duration: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Package.json reader + extractor
// ---------------------------------------------------------------------------

/**
 * Read a package.json file and return a FlowEntry.
 * Returns null when the file cannot be read or parsed.
 */
async function readFlowEntry(pkgPath: string): Promise<FlowEntry | null> {
  let raw: string;
  try {
    raw = await readFile(pkgPath, { encoding: 'utf8' });
  } catch {
    return null;
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null;

  const p = pkg as Record<string, unknown>;

  const pkgName = typeof p['name'] === 'string' ? p['name'] : '';
  const pkgVersion = typeof p['version'] === 'string' ? p['version'] : '0.0.0';
  const pkgDesc = typeof p['description'] === 'string' ? p['description'] : '';

  const relayMeta: RelayMeta =
    p['relay'] !== undefined &&
    p['relay'] !== null &&
    typeof p['relay'] === 'object' &&
    !Array.isArray(p['relay'])
      ? (p['relay'] as RelayMeta)
      : {};

  // Display name: relay.displayName > package name stripped of scope prefix > directory fallback
  const strippedName = pkgName.replace(/^@ganderbite\/flow-/, '');
  const displayName = relayMeta.displayName ?? (strippedName.length > 0 ? strippedName : pkgName);

  // Cost: relay.estimatedCostUsd.max (range) or relay.estimatedCostUsd (number) or relay.cost
  const costNum = extractMax(relayMeta.estimatedCostUsd);
  const cost = costNum !== null ? `$${costNum.toFixed(2)}` : '';

  // Duration: relay.estimatedDurationMin.max (range) or number
  const durNum = extractMax(relayMeta.estimatedDurationMin);
  const duration = durNum !== null ? `${durNum}m` : '';

  // Description: relay.description (meta) > package description
  const description =
    typeof relayMeta.description === 'string' && relayMeta.description.length > 0
      ? relayMeta.description
      : pkgDesc;

  return {
    displayName,
    version: pkgVersion,
    cost,
    duration,
    description,
  };
}

/**
 * Extract the max value from an estimatedCostUsd / estimatedDurationMin field.
 * Accepts a range object `{ min, max }` or a bare number. Returns null on absent/invalid.
 */
function extractMax(field: unknown): number | null {
  if (typeof field === 'number' && isFinite(field)) return field;
  if (
    field !== null &&
    typeof field === 'object' &&
    !Array.isArray(field) &&
    typeof (field as Record<string, unknown>)['max'] === 'number'
  ) {
    return (field as { max: number }).max;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source scanners
// ---------------------------------------------------------------------------

/**
 * Scan <cwd>/.relay/flows/{name}/package.json - local installed flows.
 */
async function scanLocalFlows(cwd: string): Promise<FlowEntry[]> {
  const flowsDir = join(cwd, '.relay', 'flows');
  let entries: string[];
  try {
    entries = await readdir(flowsDir);
  } catch {
    return [];
  }

  const results: FlowEntry[] = [];
  for (const entry of entries) {
    const pkgPath = join(flowsDir, entry, 'package.json');
    const flow = await readFlowEntry(pkgPath);
    if (flow !== null) results.push(flow);
  }
  return results;
}

/**
 * Scan <cwd>/node_modules/@ganderbite/flow-{name}/package.json - workspace flows.
 */
async function scanWorkspaceFlows(cwd: string): Promise<FlowEntry[]> {
  const scopeDir = join(cwd, 'node_modules', '@ganderbite');
  let entries: string[];
  try {
    entries = await readdir(scopeDir);
  } catch {
    return [];
  }

  const results: FlowEntry[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('flow-')) continue;
    const pkgPath = join(scopeDir, entry, 'package.json');
    const flow = await readFlowEntry(pkgPath);
    if (flow !== null) results.push(flow);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Remote catalog shape (minimal — we only read what we display)
// ---------------------------------------------------------------------------

interface CatalogEntry {
  name?: string;
  version?: string;
  description?: string;
  relay?: RelayMeta;
}

/**
 * Fetch the remote catalog at https://relay.dev/registry.json with a 5s timeout.
 * Returns an array of FlowEntry on success, or null on any failure (network,
 * timeout, parse error). The caller handles the null → gray note.
 */
async function fetchRemoteCatalog(): Promise<FlowEntry[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  let json: unknown;
  try {
    const res = await fetch('https://relay.dev/registry.json', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }

  if (!Array.isArray(json)) return null;

  const results: FlowEntry[] = [];
  for (const item of json as CatalogEntry[]) {
    if (item === null || typeof item !== 'object') continue;

    const relayMeta: RelayMeta =
      item.relay !== undefined && item.relay !== null && typeof item.relay === 'object'
        ? item.relay
        : {};

    const rawName = typeof item.name === 'string' ? item.name : '';
    const version = typeof item.version === 'string' ? item.version : '0.0.0';
    const pkgDesc = typeof item.description === 'string' ? item.description : '';
    const strippedName = rawName.replace(/^@ganderbite\/flow-/, '');
    const displayName = relayMeta.displayName ?? (strippedName.length > 0 ? strippedName : rawName);

    const costNum = extractMax(relayMeta.estimatedCostUsd);
    const cost = costNum !== null ? `$${costNum.toFixed(2)}` : '';
    const durNum = extractMax(relayMeta.estimatedDurationMin);
    const duration = durNum !== null ? `${durNum}m` : '';
    const description =
      typeof relayMeta.description === 'string' && relayMeta.description.length > 0
        ? relayMeta.description
        : pkgDesc;

    if (displayName.length === 0) continue;

    results.push({ displayName, version, cost, duration, description });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/**
 * Merge entry lists, keeping the first occurrence of each display name.
 * Preserves the source priority: local > workspace > remote.
 */
function dedup(lists: FlowEntry[][]): FlowEntry[] {
  const seen = new Set<string>();
  const merged: FlowEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const key = entry.displayName.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

/**
 * Compute the name column width: max display name length + 2, clamped to NAME_COL minimum.
 */
function nameColWidth(entries: FlowEntry[]): number {
  if (entries.length === 0) return NAME_COL;
  const max = Math.max(...entries.map((e) => e.displayName.length));
  return Math.max(max + 2, NAME_COL);
}

/**
 * Truncate a string to maxLen, appending nothing (the reader can see the row ends).
 */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * Render one table row for a flow entry.
 *
 *   " codebase-discovery    v0.1.0    20m  $0.40   PM-ready report on an unknown repo"
 */
function renderRow(entry: FlowEntry, namePad: number): string {
  const name = entry.displayName.padEnd(namePad);
  const ver = `v${entry.version}`.padEnd(VER_COL);
  const dur = entry.duration.padEnd(DUR_COL);
  const cost = entry.cost.padEnd(COST_COL);
  const desc = truncate(entry.description, DESC_MAX);
  return ` ${name}${ver}${dur}${cost}${desc}`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay list`.
 * Scans local, workspace, and remote sources and prints the installed-flows table.
 */
export default async function listCommand(_args: unknown[], _opts: unknown): Promise<void> {
  const cwd = process.cwd();

  // Header — verbatim from product spec §6.8
  process.stdout.write(`${MARK}  installed flows (./.relay/flows/)\n`);
  process.stdout.write('\n');

  // Scan all sources concurrently; remote may fail
  const [local, workspace, remoteResult] = await Promise.all([
    scanLocalFlows(cwd),
    scanWorkspaceFlows(cwd),
    fetchRemoteCatalog(),
  ]);

  const remoteCatalogUnavailable = remoteResult === null;
  const remote = remoteResult ?? [];

  // Merge, dedup by display name (local wins over workspace wins over remote)
  const flows = dedup([local, workspace, remote]);

  if (flows.length === 0) {
    process.stdout.write('  no flows installed. browse the catalog: relay search <query>\n');
    if (remoteCatalogUnavailable) {
      process.stdout.write(
        gray('  (catalog unavailable — relay search may be out of date)') + '\n',
      );
    }
    return;
  }

  // Dynamic name column width based on actual data
  const namePad = nameColWidth(flows);

  for (const flow of flows) {
    process.stdout.write(renderRow(flow, namePad) + '\n');
  }

  process.stdout.write('\n');

  // Footer — verbatim from product spec §6.8
  process.stdout.write(`${flows.length} flows installed. search more: relay search <query>\n`);

  if (remoteCatalogUnavailable) {
    process.stdout.write(gray('  (catalog unavailable — relay search may be out of date)') + '\n');
  }
}
