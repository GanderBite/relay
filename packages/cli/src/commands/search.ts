/**
 * `relay search <query>` — finds races in the public catalog.
 *
 * Output shape (product spec §6.8):
 *
 *   ●─▶●─▶●─▶●  search: migration
 *
 *    migration-planner          v0.3.0    25m  $0.60    verified
 *    dependency-upgrade-plan    v0.1.4    12m  $0.30    verified
 *    framework-port             v0.0.2    30m  $0.80    community
 *
 *   3 matches. install with: relay install <name>
 *
 * On network failure:
 *   ⚠ unable to reach catalog; retry later.
 *
 * Registry cache: ~/.relay/registry.json, 1-hour TTL.
 * Fetch endpoint: https://relay.dev/registry.json, 5-second timeout.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MARK, SYMBOLS } from '../brand.js';
import { gray, yellow } from '../color.js';

// ---------------------------------------------------------------------------
// Column widths — derived from the spec §6.8 example
//
//   " migration-planner          v0.3.0    25m  $0.60    verified"
//     name padEnd(27)            ver(10)  dur(5) cost(9)  tier
// ---------------------------------------------------------------------------

const NAME_COL_MIN = 27; // minimum name padEnd — matches spec's longest example
const VER_COL = 10; // "v0.3.0" + 4 trailing spaces
const DUR_COL = 5; // "25m" + 2 trailing spaces
const COST_COL = 9; // "$0.60" + 4 trailing spaces

// ---------------------------------------------------------------------------
// Registry entry shape
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  tags?: string[];
  tier: 'verified' | 'community';
  installCount?: number;
  relay?: {
    cost?: string | number;
    duration?: string | number;
    estimatedCostUsd?: { min: number; max: number };
    estimatedDurationMin?: { min: number; max: number };
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 3_600_000; // 1 hour
const CACHE_PATH = join(homedir(), '.relay', 'registry.json');
const REGISTRY_URL = 'https://relay.dev/registry.json';
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Read the cache file and return its contents if it is still fresh (within TTL).
 * Returns null when the file is absent, unreadable, unparseable, or stale.
 */
async function readCache(): Promise<RegistryEntry[] | null> {
  let mtimeMs: number;
  try {
    const s = await stat(CACHE_PATH);
    mtimeMs = s.mtimeMs;
  } catch {
    return null;
  }

  if (Date.now() - mtimeMs > CACHE_TTL_MS) return null;

  let raw: string;
  try {
    raw = await readFile(CACHE_PATH, { encoding: 'utf8' });
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  return parsed as RegistryEntry[];
}

/**
 * Read the cache file regardless of TTL.
 * Used as the stale fallback when network is unavailable.
 * Returns null when absent, unreadable, or unparseable.
 */
async function readStaleCache(): Promise<RegistryEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(CACHE_PATH, { encoding: 'utf8' });
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  return parsed as RegistryEntry[];
}

/**
 * Write entries to the cache file, creating ~/.relay/ if needed.
 * Errors are silently swallowed — cache writes are best-effort.
 */
async function writeCache(entries: RegistryEntry[]): Promise<void> {
  try {
    await mkdir(join(homedir(), '.relay'), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(entries), { encoding: 'utf8' });
  } catch {
    // best-effort; silently ignore write failures
  }
}

/**
 * Fetch the registry from the network with a 5-second timeout.
 * Returns the parsed array on success, or null on any failure.
 */
async function fetchRegistry(): Promise<RegistryEntry[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let json: unknown;
  try {
    const res = await fetch(REGISTRY_URL, {
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

  // Support both the new { races: [...] } shape and a legacy flat array.
  if (Array.isArray(json)) return json as RegistryEntry[];
  if (json !== null && typeof json === 'object' && 'races' in (json as object)) {
    const races = (json as Record<string, unknown>)['races'];
    if (Array.isArray(races)) return races as RegistryEntry[];
  }
  return null;
}

/**
 * Load the registry using cache-first strategy:
 *   1. Fresh cache → return immediately.
 *   2. Stale / absent → fetch from network, write cache, return.
 *   3. Network failure + stale cache exists → return stale cache.
 *   4. Network failure + no cache → return null (caller emits warning).
 */
async function loadRegistry(): Promise<RegistryEntry[] | null> {
  const fresh = await readCache();
  if (fresh !== null) return fresh;

  const fetched = await fetchRegistry();
  if (fetched !== null) {
    await writeCache(fetched);
    return fetched;
  }

  // Network failed — fall back to stale cache if available
  return readStaleCache();
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

/**
 * Return true when the query string appears (case-insensitive) in any of the
 * entry's searchable fields: name, displayName, tags, description.
 */
function matchesQuery(entry: RegistryEntry, query: string): boolean {
  const q = query.toLowerCase();
  const fields = [
    entry.name,
    entry.displayName ?? '',
    (entry.tags ?? []).join(' '),
    entry.description ?? '',
  ];
  return fields.some((f) => f.toLowerCase().includes(q));
}

/**
 * Sort entries: verified first, then by installCount descending.
 * Within the same tier, higher installCount ranks first.
 */
function sortEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return [...entries].sort((a, b) => {
    // Tier: verified (0) before community (1)
    const tierA = a.tier === 'verified' ? 0 : 1;
    const tierB = b.tier === 'verified' ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    // Within same tier: higher installCount first
    const countA = a.installCount ?? 0;
    const countB = b.installCount ?? 0;
    return countB - countA;
  });
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Extract a cost string from an entry's relay metadata.
 * Returns empty string when no cost information is present.
 */
function extractCost(entry: RegistryEntry): string {
  const r = entry.relay;
  if (r === undefined) return '';

  if (r.estimatedCostUsd !== undefined) {
    const max = r.estimatedCostUsd.max;
    return `$${max.toFixed(2)}`;
  }

  if (typeof r.cost === 'number' && isFinite(r.cost)) {
    return `$${r.cost.toFixed(2)}`;
  }

  if (typeof r.cost === 'string' && r.cost.length > 0) {
    return r.cost.startsWith('$') ? r.cost : `$${r.cost}`;
  }

  return '';
}

/**
 * Extract a duration string from an entry's relay metadata.
 * Returns empty string when no duration information is present.
 */
function extractDuration(entry: RegistryEntry): string {
  const r = entry.relay;
  if (r === undefined) return '';

  if (r.estimatedDurationMin !== undefined) {
    return `${r.estimatedDurationMin.max}m`;
  }

  if (typeof r.duration === 'number' && isFinite(r.duration)) {
    return `${r.duration}m`;
  }

  if (typeof r.duration === 'string' && r.duration.length > 0) {
    return r.duration;
  }

  return '';
}

/**
 * Compute the name column width: max display name length + 2,
 * clamped to NAME_COL_MIN (27) as a minimum.
 */
function nameColWidth(entries: RegistryEntry[]): number {
  if (entries.length === 0) return NAME_COL_MIN;
  const max = Math.max(...entries.map((e) => (e.displayName ?? e.name).length));
  return Math.max(max + 2, NAME_COL_MIN);
}

/**
 * Render one table row for a registry entry.
 *
 * Format (product spec §6.8):
 *   " migration-planner          v0.3.0    25m  $0.60    verified"
 */
function renderRow(entry: RegistryEntry, namePad: number): string {
  const displayName = entry.displayName ?? entry.name;
  const name = displayName.padEnd(namePad);
  const version = `v${entry.version}`.padEnd(VER_COL);
  const duration = extractDuration(entry).padEnd(DUR_COL);
  const cost = extractCost(entry).padEnd(COST_COL);
  const tier = gray(entry.tier);
  return ` ${name}${version}${duration}${cost}${tier}`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay search <query>`.
 * args[0] is the query string.
 */
export default async function searchCommand(args: unknown[], _opts: unknown): Promise<void> {
  const query = typeof args[0] === 'string' ? args[0] : '';

  // Header — verbatim from product spec §6.8
  process.stdout.write(`${MARK}  search: ${query}\n`);
  process.stdout.write('\n');

  const entries = await loadRegistry();

  if (entries === null) {
    process.stdout.write(`${yellow(SYMBOLS.warn)} unable to reach catalog; retry later.\n`);
    return;
  }

  const matches = sortEntries(entries.filter((e) => matchesQuery(e, query)));

  if (matches.length === 0) {
    process.stdout.write(`  no races match "${query}". try a broader search term.\n`);
    return;
  }

  const namePad = nameColWidth(matches);

  for (const entry of matches) {
    process.stdout.write(renderRow(entry, namePad) + '\n');
  }

  process.stdout.write('\n');

  // Footer — verbatim from product spec §6.8
  process.stdout.write(`${matches.length} matches. install with: relay install <name>\n`);
}
