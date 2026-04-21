/**
 * relay publish — lint, build, and publish a flow package to npm.
 *
 * Steps:
 *   1. lintFlowPackage(dir) — fail on any ERROR finding, warn on WARN finding
 *   2. npm run build inside the package if a build script exists
 *   3. npm publish --access public (skipped when --dry-run)
 *   4. generateRegistryJson against the published package — print registry diff
 *
 * Flags:
 *   --dry-run   perform all steps except the actual npm publish
 *
 * Exit codes:
 *   0 — published successfully (or dry-run completed)
 *   1 — lint errors, build failure, or publish failure
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { lintFlowPackage } from '../lint.js';
import type { LintFinding } from '../lint.js';
import { generateRegistryJson } from '../registry.js';
import type { RegistryEntry } from '../registry.js';
import { MARK, SYMBOLS, green, yellow, red, gray } from '../visual.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public command interface
// ---------------------------------------------------------------------------

export interface PublishCommandOptions {
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Width of the label column for finding rows. */
const FINDING_PREFIX_WIDTH = 4; // ' ⚠  ' or ' ✕  '

/** Emit a single lint finding row to stdout. */
function printFinding(symbol: string, finding: LintFinding): void {
  const pathLabel = finding.path !== undefined ? gray(` [${finding.path}]`) : '';
  process.stdout.write(`${symbol.padEnd(FINDING_PREFIX_WIDTH)}${finding.message}${pathLabel}\n`);
}

/**
 * Read the scripts block from a package.json file.
 * Returns null when the file is unreadable or has no scripts block.
 */
async function readBuildScript(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(`${dir}/package.json`, 'utf8');
    const pkg = JSON.parse(raw) as unknown;
    if (pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)) {
      const scripts = (pkg as Record<string, unknown>)['scripts'];
      if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
        const build = (scripts as Record<string, unknown>)['build'];
        if (typeof build === 'string') return build;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the package name and version from a package.json file.
 * Returns null when the file is unreadable or missing required fields.
 */
async function readPackageMeta(dir: string): Promise<{ name: string; version: string } | null> {
  try {
    const raw = await readFile(`${dir}/package.json`, 'utf8');
    const pkg = JSON.parse(raw) as unknown;
    if (pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)) {
      const p = pkg as Record<string, unknown>;
      if (typeof p['name'] === 'string' && typeof p['version'] === 'string') {
        return { name: p['name'], version: p['version'] };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute a human-readable registry diff between the previous entry for a
 * package and the newly generated entry.
 *
 * Returns an array of lines to print — never empty:
 *   - "new package added to registry" for first-time publishes
 *   - Changed field lines for subsequent publishes
 */
function registryDiff(
  prev: RegistryEntry | undefined,
  next: RegistryEntry,
): string[] {
  if (prev === undefined) {
    return ['new package added to registry'];
  }

  const lines: string[] = [];

  if (prev.version !== next.version) {
    lines.push(`version   ${gray(prev.version)} → ${green(next.version)}`);
  }
  if (prev.displayName !== next.displayName) {
    lines.push(`displayName  ${gray(prev.displayName)} → ${next.displayName}`);
  }
  if (prev.description !== next.description) {
    lines.push(`description  updated`);
  }
  if (JSON.stringify(prev.tags) !== JSON.stringify(next.tags)) {
    lines.push(`tags      ${gray(prev.tags.join(', '))} → ${next.tags.join(', ')}`);
  }
  if (JSON.stringify(prev.audience) !== JSON.stringify(next.audience)) {
    lines.push(`audience  ${gray(prev.audience.join(', '))} → ${next.audience.join(', ')}`);
  }
  if (
    prev.estimatedCostUsd.min !== next.estimatedCostUsd.min ||
    prev.estimatedCostUsd.max !== next.estimatedCostUsd.max
  ) {
    lines.push(
      `cost      ${gray(`$${prev.estimatedCostUsd.min}–$${prev.estimatedCostUsd.max}`)} → $${next.estimatedCostUsd.min}–$${next.estimatedCostUsd.max}`,
    );
  }
  if (
    prev.estimatedDurationMin.min !== next.estimatedDurationMin.min ||
    prev.estimatedDurationMin.max !== next.estimatedDurationMin.max
  ) {
    lines.push(
      `duration  ${gray(`${prev.estimatedDurationMin.min}–${prev.estimatedDurationMin.max}min`)} → ${next.estimatedDurationMin.min}–${next.estimatedDurationMin.max}min`,
    );
  }

  if (lines.length === 0) {
    lines.push('no registry fields changed');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// publishCommand
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay publish <path> [--dry-run]`.
 */
export default async function publishCommand(
  args: unknown[],
  opts: unknown,
): Promise<void> {
  const options = (opts ?? {}) as PublishCommandOptions;
  const dryRun = options.dryRun === true;

  const rawPath = typeof args[0] === 'string' ? args[0].trim() : '';

  if (rawPath === '') {
    process.stderr.write(
      red(`${SYMBOLS.fail} usage: relay publish <path> [--dry-run]`) + '\n',
    );
    process.exit(1);
  }

  const dir = resolve(rawPath);

  // Header
  const modeLabel = dryRun ? '  (dry run)' : '';
  process.stdout.write(`${MARK}  relay publish${modeLabel}\n`);
  process.stdout.write('\n');
  process.stdout.write(gray(`path    ${dir}`) + '\n');
  process.stdout.write('\n');

  // ---------------------------------------------------------------------------
  // Step 1 — lint
  // ---------------------------------------------------------------------------
  process.stdout.write('linting...\n');

  const lintResult = await lintFlowPackage(dir);

  if (lintResult.isErr()) {
    process.stderr.write(
      red(` ${SYMBOLS.fail} lint failed: ${lintResult.error.message}`) + '\n',
    );
    process.stderr.write('\n');
    process.stderr.write(`  → check the directory exists: relay publish <path>\n`);
    process.exit(1);
  }

  const report = lintResult.value;

  // Print warnings (non-blocking)
  for (const w of report.warnings) {
    printFinding(yellow(` ${SYMBOLS.warn} `), w);
  }

  // Print errors (blocking)
  for (const e of report.errors) {
    printFinding(red(` ${SYMBOLS.fail} `), e);
  }

  if (report.errors.length > 0) {
    process.stdout.write('\n');
    const noun = report.errors.length === 1 ? 'error' : 'errors';
    process.stdout.write(
      red(`${report.errors.length} lint ${noun} — fix before publishing.`) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write(`  → relay publish ${rawPath}\n`);
    process.exit(1);
  }

  const warnSuffix =
    report.warnings.length > 0
      ? `  (${report.warnings.length} ${report.warnings.length === 1 ? 'warning' : 'warnings'})`
      : '';

  process.stdout.write(green(` ${SYMBOLS.ok} lint passed${warnSuffix}`) + '\n');
  process.stdout.write('\n');

  // ---------------------------------------------------------------------------
  // Step 2 — build (if build script present)
  // ---------------------------------------------------------------------------
  const buildScript = await readBuildScript(dir);

  if (buildScript !== null) {
    process.stdout.write(gray(`$ npm run build`) + '\n');

    try {
      const buildResult = await execFileAsync('npm', ['run', 'build'], {
        cwd: dir,
      });
      if (buildResult.stdout.trim().length > 0) {
        process.stdout.write(gray(buildResult.stdout.trimEnd()) + '\n');
      }
    } catch (buildErr: unknown) {
      const stderr =
        buildErr instanceof Error && 'stderr' in buildErr
          ? String((buildErr as Record<string, unknown>)['stderr'])
          : buildErr instanceof Error
            ? buildErr.message
            : String(buildErr);

      process.stderr.write(
        red(` ${SYMBOLS.fail} build failed`) + '\n',
      );
      if (stderr.trim().length > 0) {
        process.stderr.write(gray(stderr.trim()) + '\n');
      }
      process.stderr.write('\n');
      process.stderr.write(`  → fix the build error, then: relay publish ${rawPath}\n`);
      process.exit(1);
    }

    process.stdout.write(green(` ${SYMBOLS.ok} build succeeded`) + '\n');
    process.stdout.write('\n');
  }

  // ---------------------------------------------------------------------------
  // Step 3 — npm publish (skipped in dry-run)
  // ---------------------------------------------------------------------------
  if (dryRun) {
    process.stdout.write(
      yellow(` ${SYMBOLS.warn} dry run — skipping npm publish`) + '\n',
    );
    process.stdout.write('\n');
    process.stdout.write('to publish for real:\n');
    process.stdout.write(gray(`    relay publish ${rawPath}`) + '\n');
    process.exit(0);
  }

  process.stdout.write(gray(`$ npm publish --access public`) + '\n');

  try {
    const publishResult = await execFileAsync(
      'npm',
      ['publish', '--access', 'public'],
      { cwd: dir },
    );
    if (publishResult.stdout.trim().length > 0) {
      process.stdout.write(gray(publishResult.stdout.trimEnd()) + '\n');
    }
  } catch (publishErr: unknown) {
    const stderr =
      publishErr instanceof Error && 'stderr' in publishErr
        ? String((publishErr as Record<string, unknown>)['stderr'])
        : publishErr instanceof Error
          ? publishErr.message
          : String(publishErr);

    process.stderr.write(
      red(` ${SYMBOLS.fail} npm publish failed`) + '\n',
    );
    if (stderr.trim().length > 0) {
      process.stderr.write(gray(stderr.trim()) + '\n');
    }
    process.stderr.write('\n');
    process.stderr.write(`  → relay publish ${rawPath}\n`);
    process.exit(1);
  }

  // Read what was just published to report the name@version
  const meta = await readPackageMeta(dir);
  const publishedLabel =
    meta !== null ? `${meta.name}@${meta.version}` : dir;

  process.stdout.write(green(` ${SYMBOLS.ok} published ${publishedLabel}`) + '\n');
  process.stdout.write('\n');

  // ---------------------------------------------------------------------------
  // Step 4 — registry diff
  // ---------------------------------------------------------------------------

  // Generate the registry entry for the just-published package (by name — it
  // is now on npm, so processNpmPackage will pick it up). Fall back to local
  // dir read on failure (the package may not yet be indexed).
  const packageInput = meta !== null ? meta.name : dir;

  const regResult = await generateRegistryJson([packageInput]);

  if (regResult.isErr()) {
    // Non-fatal: the registry update may lag behind the publish.
    process.stdout.write(
      yellow(` ${SYMBOLS.warn} registry update not available yet — try: relay search`) + '\n',
    );
    process.stdout.write('\n');
  } else {
    const doc = regResult.value;
    const nextEntry = doc.flows.find((f) => f.name === (meta?.name ?? ''));

    if (nextEntry === undefined) {
      process.stdout.write(
        gray(`registry    no entry found for ${packageInput}`) + '\n',
      );
    } else {
      process.stdout.write('registry diff:\n');
      const diffLines = registryDiff(undefined, nextEntry);
      for (const line of diffLines) {
        process.stdout.write(`    ${line}\n`);
      }
    }

    process.stdout.write('\n');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  process.stdout.write(green(`published.`) + '\n');
  process.stdout.write('\n');
  process.stdout.write('next:\n');
  process.stdout.write(gray(`    view in catalog    relay search ${meta?.name ?? rawPath}`) + '\n');
}
