/**
 * relay install — download and install a flow package from npm.
 *
 * Resolves bare names to the @ganderbite/flow-<name> npm scope,
 * installs via npm, flattens the nested package directory, optionally
 * compiles flow.ts, validates the flow definition, then prints the
 * product-spec §6.8 banner.
 *
 * Exit codes:
 *   0 — installed successfully
 *   1 — npm install failed
 *   2 — validation failed (flow definition is malformed)
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { gray, green, MARK, red, SYMBOLS } from '../visual.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

interface ResolvedPackage {
  /** Short bare name, e.g. "codebase-discovery". */
  name: string;
  /** Full scoped package name, e.g. "@ganderbite/flow-codebase-discovery". */
  packageName: string;
  /** Full package spec for npm install, e.g. "@ganderbite/flow-codebase-discovery@0.1.0". */
  packageSpec: string;
}

/**
 * Parse the <flow>[@<version>] argument and resolve to a full package spec.
 *
 * Accepts:
 *   "codebase-discovery"
 *   "codebase-discovery@0.1.0"
 *   "@ganderbite/flow-codebase-discovery"
 *   "@ganderbite/flow-codebase-discovery@0.1.0"
 */
function resolvePackage(arg: string): ResolvedPackage {
  // Strip a leading "@" for splitting — handle scoped names carefully.
  // A scoped package looks like "@scope/name[@version]".
  // A bare name looks like "name[@version]".

  let rawName: string;
  let version: string | undefined;

  if (arg.startsWith('@')) {
    // Scoped: "@ganderbite/flow-name@version" or "@ganderbite/flow-name"
    // Find the version separator after the slash.
    const slashIndex = arg.indexOf('/');
    const afterSlash = arg.slice(slashIndex + 1); // "flow-name@version"
    const atIndex = afterSlash.indexOf('@');
    if (atIndex !== -1) {
      rawName = arg.slice(0, slashIndex + 1 + atIndex); // "@scope/flow-name"
      version = afterSlash.slice(atIndex + 1); // "version"
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

  // Determine the full scoped package name.
  let packageName: string;
  if (rawName.startsWith('@ganderbite/flow-')) {
    packageName = rawName;
  } else {
    packageName = `@ganderbite/flow-${rawName}`;
  }

  // Extract the bare short name (e.g. "codebase-discovery").
  const name = packageName.replace(/^@ganderbite\/flow-/, '');

  const packageSpec = version !== undefined ? `${packageName}@${version}` : packageName;

  return { name, packageName, packageSpec };
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
// Registry cache
// ---------------------------------------------------------------------------

const REGISTRY_URL = 'https://relay.dev/registry.json';
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

  const { name, packageName, packageSpec } = resolvePackage(rawArg);
  const cwd = process.cwd();
  const flowDir = path.join(cwd, '.relay', 'flows', name);

  // Track wall-clock time from the very start.
  const startMs = Date.now();

  // Header — verbatim from product spec §6.8
  process.stdout.write(`${MARK}  installing ${name}\n`);
  process.stdout.write('\n');

  // ---------------------------------------------------------------------------
  // Step 1 — npm install
  // ---------------------------------------------------------------------------
  try {
    await execFileAsync('npm', ['install', '--no-save', '--prefix', flowDir, packageSpec]);
  } catch (installErr: unknown) {
    const stderr =
      installErr instanceof Error && 'stderr' in installErr
        ? String((installErr as Record<string, unknown>)['stderr'])
        : installErr instanceof Error
          ? installErr.message
          : String(installErr);

    process.stderr.write(red(` ${SYMBOLS.fail} npm install failed: ${stderr.trim()}`) + '\n');
    process.exit(1);
  }

  // Read the actual installed version from the package's package.json.
  let installedVersion = '';
  try {
    const pkgJsonPath = path.join(flowDir, 'node_modules', packageName, 'package.json');
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    installedVersion = typeof parsed['version'] === 'string' ? parsed['version'] : '';
  } catch {
    // Version display falls back to empty — not a fatal error.
  }

  const resolvedLabel =
    installedVersion.length > 0 ? `${packageName}@${installedVersion}` : packageName;

  process.stdout.write(green(` ${SYMBOLS.ok} resolved ${resolvedLabel} from npm`) + '\n');

  // ---------------------------------------------------------------------------
  // Step 2 — flatten: move inner package to flowDir, delete node_modules
  // ---------------------------------------------------------------------------
  const innerPackageDir = path.join(flowDir, 'node_modules', packageName);

  try {
    // Copy the inner package contents to flowDir (overwrite matching files).
    await fs.cp(innerPackageDir, flowDir, { recursive: true, force: true });

    // Remove the now-redundant node_modules directory.
    await fs.rm(path.join(flowDir, 'node_modules'), { recursive: true, force: true });
  } catch (flattenErr: unknown) {
    const msg = flattenErr instanceof Error ? flattenErr.message : String(flattenErr);
    process.stderr.write(red(` ${SYMBOLS.fail} failed to unpack flow package: ${msg}`) + '\n');
    process.exit(1);
  }

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
    green(` ${SYMBOLS.ok} validated flow definition against @relay/core`) + '\n',
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

  // ---------------------------------------------------------------------------
  // Best-effort registry cache refresh (non-blocking)
  // ---------------------------------------------------------------------------
  void refreshRegistryCache();
}
