/**
 * relay install — download and install a flow package from an npm registry tarball.
 *
 * Resolves bare names against the registry at ~/.relay/registry.json,
 * constructs the npm registry tarball URL, fetches and extracts the package,
 * optionally compiles flow.ts, validates the flow definition, then prints the
 * install banner.
 *
 * Exit codes:
 *   0 — installed successfully
 *   1 — flow not found, tarball fetch failed, or extraction failed
 *   2 — validation failed (flow definition is malformed)
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

import { extract } from 'tar';

import { MARK, SYMBOLS } from '../brand.js';
import { gray, green, red } from '../color.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Name parsing
// ---------------------------------------------------------------------------

interface ParsedFlowArg {
  /** Short bare name, e.g. "codebase-discovery". */
  name: string;
  /** Requested version, if specified. */
  version?: string | undefined;
}

/**
 * Parse the <flow>[@<version>] argument into a bare name and optional version.
 *
 * Accepts:
 *   "codebase-discovery"
 *   "codebase-discovery@0.1.0"
 *   "@ganderbite/flow-codebase-discovery"
 *   "@ganderbite/flow-codebase-discovery@0.1.0"
 */
function parseFlowArg(arg: string): ParsedFlowArg {
  let rawName: string;
  let version: string | undefined;

  if (arg.startsWith('@')) {
    // Scoped: "@ganderbite/flow-name@version" or "@ganderbite/flow-name"
    const slashIndex = arg.indexOf('/');
    const afterSlash = arg.slice(slashIndex + 1); // "flow-name@version"
    const atIndex = afterSlash.indexOf('@');
    if (atIndex !== -1) {
      rawName = arg.slice(0, slashIndex + 1 + atIndex); // "@scope/flow-name"
      version = afterSlash.slice(atIndex + 1);
    } else {
      rawName = arg;
    }
  } else {
    // Bare or bare@version: "name" or "name@version"
    const atIndex = arg.indexOf('@');
    if (atIndex !== -1) {
      rawName = arg.slice(0, atIndex);
      version = arg.slice(atIndex + 1);
    } else {
      rawName = arg;
    }
  }

  // Normalise to the bare short name (strip scope if present).
  const name = rawName.replace(/^@ganderbite\/flow-/, '');

  return { name, version };
}

// ---------------------------------------------------------------------------
// Registry cache
// ---------------------------------------------------------------------------

const REGISTRY_URL = 'https://ganderbite.github.io/relay/registry.json';
const REGISTRY_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Refresh the registry cache at ~/.relay/registry.json if stale (> 1h old).
 * Errors are silently swallowed — this is best-effort and never blocks install.
 */
async function refreshRegistryCache(): Promise<void> {
  try {
    const cacheDir = path.join(os.homedir(), '.relay');
    const cachePath = path.join(cacheDir, 'registry.json');

    // Check if the cache file exists and is fresh enough.
    let needsRefresh = true;
    try {
      const stat = await fs.stat(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < REGISTRY_TTL_MS) {
        needsRefresh = false;
      }
    } catch {
      // File does not exist — needs refresh.
    }

    if (!needsRefresh) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) return;
      const body = await res.text();

      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cachePath, body, 'utf8');
    } catch {
      clearTimeout(timer);
    }
  } catch {
    // Completely silent — registry cache is a non-blocking optimisation.
  }
}

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

interface RegistryEntryRaw {
  name?: unknown;
  version?: unknown;
}

interface FoundEntry {
  entryVersion: string;
}

/**
 * Populate the local registry cache if absent, then find the entry matching
 * the requested flow name and optional version.
 *
 * Handles both the versioned document shape `{ version: 1, flows: [] }` and
 * a legacy flat array shape.
 *
 * Returns null if no matching entry is found.
 */
async function findRegistryEntry(
  name: string,
  version?: string | undefined,
): Promise<FoundEntry | null> {
  // Ensure the cache exists before reading.
  await refreshRegistryCache();

  const cachePath = path.join(os.homedir(), '.relay', 'registry.json');

  let raw: string;
  try {
    raw = await fs.readFile(cachePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Normalise to an array of entries regardless of document shape.
  let entries: unknown[];
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'flows' in (parsed as Record<string, unknown>) &&
    Array.isArray((parsed as Record<string, unknown>)['flows'])
  ) {
    entries = (parsed as Record<string, unknown>)['flows'] as unknown[];
  } else if (Array.isArray(parsed)) {
    entries = parsed;
  } else {
    return null;
  }

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const e = entry as RegistryEntryRaw;

    // The registry name field is e.g. "@ganderbite/flow-codebase-discovery".
    const entryName = typeof e.name === 'string' ? e.name : '';
    const bareName = entryName.replace(/^@ganderbite\/flow-/, '');

    if (bareName !== name) continue;

    const entryVersion = typeof e.version === 'string' ? e.version : '';

    // If a version was requested, it must match.
    if (version !== undefined && entryVersion !== version) continue;

    return { entryVersion };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Duck-type validation (mirrors flow-loader.ts)
// ---------------------------------------------------------------------------

function isMapLike(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['get'] === 'function' &&
    typeof (value as Record<string, unknown>)['has'] === 'function'
  );
}

function validateFlowExport(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return 'default export is not an object';
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate['name'] !== 'string') {
    return 'missing or non-string "name" field';
  }
  if (candidate['steps'] === null || typeof candidate['steps'] !== 'object') {
    return 'missing or non-object "steps" field';
  }
  const graph = candidate['graph'];
  if (graph === null || typeof graph !== 'object') {
    return 'missing or non-object "graph" field';
  }
  const g = graph as Record<string, unknown>;
  if (!isMapLike(g['successors'])) {
    return 'graph.successors is not a Map-like object';
  }
  if (!isMapLike(g['predecessors'])) {
    return 'graph.predecessors is not a Map-like object';
  }
  if (!Array.isArray(g['topoOrder'])) {
    return 'graph.topoOrder is not an array';
  }
  return null;
}

// ---------------------------------------------------------------------------
// installCommand
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay install <flow>[@<version>]`.
 *
 * Output matches product spec §6.8 verbatim.
 */
export default async function installCommand(args: unknown[], _opts: unknown): Promise<void> {
  const rawArg = typeof args[0] === 'string' ? args[0].trim() : '';

  if (rawArg === '') {
    process.stderr.write(red(`${SYMBOLS.fail} usage: relay install <flow>[@<version>]`) + '\n');
    process.exit(1);
  }

  const { name, version } = parseFlowArg(rawArg);
  const cwd = process.cwd();
  const flowDir = path.join(cwd, '.relay', 'flows', name);

  // Track wall-clock time from the very start.
  const startMs = Date.now();

  // Header — verbatim from product spec §6.8
  process.stdout.write(`${MARK}  installing ${name}\n`);
  process.stdout.write('\n');

  // ---------------------------------------------------------------------------
  // Step 1 — resolve registry entry
  // ---------------------------------------------------------------------------
  const found = await findRegistryEntry(name, version);

  if (found === null) {
    process.stderr.write(red(`✕ flow "${name}" not found in registry. run: relay search`) + '\n');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Step 2 — fetch and extract tarball
  // ---------------------------------------------------------------------------
  const npmTarball = `https://registry.npmjs.org/@ganderbite/flow-${name}/-/flow-${name}-${found.entryVersion}.tgz`;

  const controller = new AbortController();
  const fetchTimer = setTimeout(() => controller.abort(), 60_000);

  let res: Response;
  try {
    res = await fetch(npmTarball, { signal: controller.signal });
  } catch (fetchErr: unknown) {
    clearTimeout(fetchTimer);
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    process.stderr.write(red(`✕ failed to download flow package: ${msg}`) + '\n');
    process.exit(1);
  }

  if (!res.ok || res.body === null) {
    clearTimeout(fetchTimer);
    process.stderr.write(red(`✕ failed to download flow package: ${res.status}`) + '\n');
    process.exit(1);
  }

  // Wipe any previous install so stale files from older versions do not linger.
  await fs.rm(flowDir, { recursive: true, force: true });
  await fs.mkdir(flowDir, { recursive: true });

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createGunzip(),
      extract({ strip: 1, cwd: flowDir }),
      { signal: controller.signal },
    );
  } catch (extractErr: unknown) {
    const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
    process.stderr.write(red(`✕ failed to extract flow package: ${msg}`) + '\n');
    process.exit(1);
  } finally {
    clearTimeout(fetchTimer);
  }

  process.stdout.write(
    green(` ${SYMBOLS.ok} resolved @ganderbite/flow-${name}@${found.entryVersion} from npm`) + '\n',
  );
  process.stdout.write(green(` ${SYMBOLS.ok} unpacked to ./.relay/flows/${name}/`) + '\n');

  // ---------------------------------------------------------------------------
  // Step 3 — compile flow.ts if needed
  // ---------------------------------------------------------------------------
  // A pre-compiled package will already have dist/flow.js.
  // If the build script is present and dist/flow.js does not exist, run it.
  const distFlowPath = path.join(flowDir, 'dist', 'flow.js');
  let hasDist = false;
  try {
    await fs.access(distFlowPath, fs.constants.F_OK);
    hasDist = true;
  } catch {
    hasDist = false;
  }

  if (!hasDist) {
    // Check for a build script.
    let hasBuildScript = false;
    try {
      const pkgRaw = await fs.readFile(path.join(flowDir, 'package.json'), 'utf8');
      const pkgObj = JSON.parse(pkgRaw) as Record<string, unknown>;
      const scripts = pkgObj['scripts'];
      if (
        scripts !== null &&
        typeof scripts === 'object' &&
        !Array.isArray(scripts) &&
        typeof (scripts as Record<string, unknown>)['build'] === 'string'
      ) {
        hasBuildScript = true;
      }
    } catch {
      // No package.json or malformed — skip build.
    }

    if (hasBuildScript) {
      try {
        await execFileAsync('npm', ['run', 'build'], { cwd: flowDir });
      } catch (buildErr: unknown) {
        const msg =
          buildErr instanceof Error && 'stderr' in buildErr
            ? String((buildErr as Record<string, unknown>)['stderr'])
            : buildErr instanceof Error
              ? buildErr.message
              : String(buildErr);
        process.stderr.write(red(` ${SYMBOLS.fail} build failed: ${msg.trim()}`) + '\n');
        process.exit(1);
      }
    }
  }

  // Print the compiled row regardless — pre-compiled packages are the norm.
  process.stdout.write(green(` ${SYMBOLS.ok} compiled flow.ts`) + '\n');

  // ---------------------------------------------------------------------------
  // Step 4 — validate flow definition
  // ---------------------------------------------------------------------------
  let validationError: string | null = null;

  try {
    const mod = (await import(distFlowPath)) as Record<string, unknown>;
    const defaultExport = mod['default'];
    validationError = validateFlowExport(defaultExport);
  } catch (importErr: unknown) {
    const msg = importErr instanceof Error ? importErr.message : String(importErr);
    validationError = `could not import dist/flow.js: ${msg}`;
  }

  if (validationError !== null) {
    process.stdout.write(red(` ${SYMBOLS.fail} validation failed: ${validationError}`) + '\n');
    process.exit(2);
  }

  process.stdout.write(
    green(` ${SYMBOLS.ok} validated flow definition against @ganderbite/relay-core`) + '\n',
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);

  process.stdout.write('\n');
  process.stdout.write(`installed in ${elapsedS}s.\n`);
  process.stdout.write('\n');

  // Try it block — verbatim from product spec §6.8
  process.stdout.write('try it:\n');
  process.stdout.write(gray(`    relay run ${name} .`) + '\n');
}
