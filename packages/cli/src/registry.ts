/**
 * Registry generator — reads race package metadata from local directories or
 * npm package names and emits a RegistryDoc suitable for serving at
 * relay.dev/registry.json.
 *
 * The same shape is consumed by:
 *   - catalog/app.js  (browser, fetches the static file)
 *   - relay search    (CLI, reads the cached copy at ~/.relay/registry.json)
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Result } from '@ganderbite/relay-core';
import { err, ok } from '@ganderbite/relay-core';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single entry in the registry, describing one published race package.
 *
 * This type is the canonical declaration — both the CLI (relay search) and
 * the catalog site (catalog/app.js) consume this exact shape.
 */
export interface RegistryEntry {
  /** npm package name, e.g. "@ganderbite/flows-codebase-discovery". */
  name: string;
  /** Strict semver version string, e.g. "0.1.0". */
  version: string;
  /** Human-readable display name from the relay metadata block. */
  displayName: string;
  /** package.json description field. */
  description: string;
  /** Tag strings from the relay metadata block. */
  tags: string[];
  /** Target audience identifiers from the relay metadata block, e.g. ["pm", "dev"]. */
  audience: string[];
  /** Estimated API cost range in USD. */
  estimatedCostUsd: { min: number; max: number };
  /** Estimated wall-clock duration range in minutes. */
  estimatedDurationMin: { min: number; max: number };
  /** Repository URL from package.json#repository.url, if present. */
  repoUrl?: string | undefined;
  /** The npm package name — same as `name`; explicit field for catalog queries. */
  npmPackage: string;
  /** First 500 characters of the README, plain text (no markdown). */
  readmeExcerpt: string;
}

/** The registry document shape served at registry.json. */
export interface RegistryDoc {
  version: 1;
  /** ISO-8601 timestamp of when this document was generated. */
  generatedAt: string;
  flows: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type RegistryErrorCode = 'PACKAGE_NOT_FOUND' | 'PACKAGE_INVALID' | 'READ_ERROR';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  /** The input (package name or path) that caused the error. */
  readonly input: string;

  constructor(message: string, code: RegistryErrorCode, input: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.input = input;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types for raw package.json shapes
// ---------------------------------------------------------------------------

interface RelayMetaBlock {
  flowName: string;
  displayName: string;
  tags: string[];
  estimatedCostUsd: { min: number; max: number };
  estimatedDurationMin: { min: number; max: number };
  audience: string[];
}

interface RawPackageJson {
  name: string;
  version: string;
  description?: string;
  repository?: string | { url?: string };
  relay?: RelayMetaBlock;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function isCostRange(v: unknown): v is { min: number; max: number } {
  if (!isRecord(v)) return false;
  return typeof v['min'] === 'number' && typeof v['max'] === 'number';
}

function isRelayMeta(v: unknown): v is RelayMetaBlock {
  if (!isRecord(v)) return false;
  if (typeof v['flowName'] !== 'string') return false;
  if (typeof v['displayName'] !== 'string') return false;
  if (!isStringArray(v['tags'])) return false;
  if (!isCostRange(v['estimatedCostUsd'])) return false;
  if (!isCostRange(v['estimatedDurationMin'])) return false;
  if (!isStringArray(v['audience'])) return false;
  return true;
}

function isRawPackageJson(v: unknown): v is RawPackageJson {
  if (!isRecord(v)) return false;
  if (typeof v['name'] !== 'string') return false;
  if (typeof v['version'] !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const README_EXCERPT_LENGTH = 500;

/**
 * Strip the most common markdown syntax to produce plain text.
 * This is intentionally minimal — just enough for a catalog excerpt.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/```[\s\S]*?```/gm, '') // fenced code blocks (must run before inline-code)
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\n{3,}/g, '\n\n') // excess blank lines
    .trim();
}

function extractReadmeExcerpt(raw: string): string {
  const plain = stripMarkdown(raw);
  return plain.length > README_EXCERPT_LENGTH ? plain.slice(0, README_EXCERPT_LENGTH) : plain;
}

function extractRepoUrl(pkg: RawPackageJson): string | undefined {
  if (pkg.repository === undefined) return undefined;
  if (typeof pkg.repository === 'string') return pkg.repository;
  if (typeof pkg.repository.url === 'string') return pkg.repository.url;
  return undefined;
}

// ---------------------------------------------------------------------------
// Local directory flow
// ---------------------------------------------------------------------------

async function processLocalDir(dir: string): Promise<Result<RegistryEntry, RegistryError>> {
  // Read package.json
  let rawPkg: unknown;
  try {
    const text = await readFile(join(dir, 'package.json'), 'utf8');
    rawPkg = JSON.parse(text);
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    return err(
      new RegistryError(`failed to read package.json from ${dir}: ${msg}`, 'READ_ERROR', dir),
    );
  }

  if (!isRawPackageJson(rawPkg)) {
    return err(
      new RegistryError(
        `package.json at ${dir} is missing required fields (name, version)`,
        'PACKAGE_INVALID',
        dir,
      ),
    );
  }

  const relayMeta = rawPkg.relay;
  if (!isRelayMeta(relayMeta)) {
    return err(
      new RegistryError(
        `package.json at ${dir} is missing a valid "relay" metadata block (flowName, displayName, tags, estimatedCostUsd, estimatedDurationMin, audience)`,
        'PACKAGE_INVALID',
        dir,
      ),
    );
  }

  // Read README.md — fall back to empty string if absent
  let readmeExcerpt = '';
  try {
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    readmeExcerpt = extractReadmeExcerpt(readme);
  } catch {
    readmeExcerpt = rawPkg.description ?? '';
  }

  const entry: RegistryEntry = {
    name: rawPkg.name,
    version: rawPkg.version,
    displayName: relayMeta.displayName,
    description: rawPkg.description ?? '',
    tags: relayMeta.tags,
    audience: relayMeta.audience,
    estimatedCostUsd: relayMeta.estimatedCostUsd,
    estimatedDurationMin: relayMeta.estimatedDurationMin,
    repoUrl: extractRepoUrl(rawPkg),
    npmPackage: rawPkg.name,
    readmeExcerpt,
  };

  return ok(entry);
}

// ---------------------------------------------------------------------------
// npm package flow
// ---------------------------------------------------------------------------

/**
 * Raw shape returned by `npm view <pkg> --json`.
 *
 * Only the fields we actually use are typed — the real output is much larger.
 */
interface NpmViewOutput {
  name?: string;
  version?: string;
  description?: string;
  repository?: string | { url?: string };
  relay?: RelayMetaBlock;
  readme?: string;
  dist?: {
    tarball?: string;
  };
}

function isNpmViewOutput(v: unknown): v is NpmViewOutput {
  return isRecord(v);
}

async function processNpmPackage(pkg: string): Promise<Result<RegistryEntry, RegistryError>> {
  // Run `npm view <pkg> --json` to get published metadata.
  let stdout: string;
  try {
    const result = await execFileAsync('npm', ['view', pkg, '--json']);
    stdout = result.stdout;
  } catch (execErr) {
    // npm exits non-zero when the package is not found.
    const msg = execErr instanceof Error ? execErr.message : String(execErr);
    return err(new RegistryError(`npm view failed for "${pkg}": ${msg}`, 'PACKAGE_NOT_FOUND', pkg));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return err(
      new RegistryError(`npm view returned non-JSON output for "${pkg}"`, 'PACKAGE_INVALID', pkg),
    );
  }

  if (!isNpmViewOutput(parsed)) {
    return err(
      new RegistryError(`unexpected npm view output shape for "${pkg}"`, 'PACKAGE_INVALID', pkg),
    );
  }

  const name = parsed.name ?? pkg;
  const version = parsed.version ?? '';

  if (version === '') {
    return err(
      new RegistryError(`npm view did not return a version for "${pkg}"`, 'PACKAGE_INVALID', pkg),
    );
  }

  const relayMeta = parsed.relay;
  if (!isRelayMeta(relayMeta)) {
    return err(
      new RegistryError(
        `"${pkg}" is missing a valid "relay" metadata block (flowName, displayName, tags, estimatedCostUsd, estimatedDurationMin, audience) in its published package.json`,
        'PACKAGE_INVALID',
        pkg,
      ),
    );
  }

  // npm view --json includes the README when the package was published with
  // one in its `files` array. Use it if available; fall back to description.
  let readmeExcerpt = '';
  if (typeof parsed.readme === 'string' && parsed.readme.length > 0) {
    readmeExcerpt = extractReadmeExcerpt(parsed.readme);
  } else {
    readmeExcerpt = parsed.description ?? '';
  }

  // Repository URL
  let repoUrl: string | undefined;
  if (parsed.repository !== undefined) {
    if (typeof parsed.repository === 'string') {
      repoUrl = parsed.repository;
    } else if (typeof parsed.repository.url === 'string') {
      repoUrl = parsed.repository.url;
    }
  }

  const entry: RegistryEntry = {
    name,
    version,
    displayName: relayMeta.displayName,
    description: parsed.description ?? '',
    tags: relayMeta.tags,
    audience: relayMeta.audience,
    estimatedCostUsd: relayMeta.estimatedCostUsd,
    estimatedDurationMin: relayMeta.estimatedDurationMin,
    repoUrl,
    npmPackage: name,
    readmeExcerpt,
  };

  return ok(entry);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an input string: local directory vs. npm package name.
 *
 * Local: starts with `.`, `..`, or `/`.
 * npm:   everything else (bare name, scoped package).
 */
function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input === '.' ||
    input === '..'
  );
}

/**
 * Generate a RegistryDoc from a list of package inputs.
 *
 * Each input is either:
 *   - A local directory path (starts with `.` or `/`): read package.json and
 *     README.md from the directory.
 *   - An npm package name (e.g. "@ganderbite/flows-codebase-discovery"): call
 *     `npm view <pkg> --json` to get published metadata.
 *
 * Returns err() only if every input fails. When some inputs succeed and some
 * fail, the successful entries are included and failures are collected into a
 * single error listing all problem packages. This matches the catalog CI use
 * case where a single bad package should not block the entire publish.
 *
 * If ALL inputs fail, returns the first error encountered.
 */
export async function generateRegistryJson(
  packages: string[],
): Promise<Result<RegistryDoc, RegistryError>> {
  const flows: RegistryEntry[] = [];
  const errors: RegistryError[] = [];

  for (const input of packages) {
    const result = isLocalPath(input)
      ? await processLocalDir(input)
      : await processNpmPackage(input);

    if (result.isOk()) {
      flows.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  // If every input failed, surface the first error.
  if (flows.length === 0 && errors.length > 0) {
    return err(errors[0] as RegistryError);
  }

  // If some succeeded, emit the doc (partial success is acceptable for catalog CI).
  const doc: RegistryDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    flows,
  };

  return ok(doc);
}
