/**
 * Race package linter.
 *
 * Checks a race package directory against the §7 contract:
 *   (1) package.json fields and relay metadata block
 *   (2) race.ts or dist/race.js presence and default-export syntax
 *   (3) README.md §7.4 ordered sections
 *   (4) prompts/ directory when any runner references promptFile
 *   (5) schemas/ files presence (compile check deferred to tsc)
 *
 * All fallible operations return Result<T, E> via neverthrow. No throws.
 */

import { readFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, err } from '@relay/core';
import type { Result } from '@relay/core';
import semver from 'semver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single lint finding — an error or warning produced during linting. */
export interface LintFinding {
  /** Machine-readable code for programmatic use by callers. */
  code: string;
  /** Human-readable description of the problem. */
  message: string;
  /** The file (relative to the package dir) the finding applies to, if known. */
  path?: string;
}

/** The result of a successful lint run — may still contain errors and warnings. */
export interface LintReport {
  errors: LintFinding[];
  warnings: LintFinding[];
}

/**
 * Wraps an unexpected internal failure that prevented the linter from running
 * at all (e.g., the directory is not readable). Normal lint findings go in
 * LintReport.errors / .warnings, not here.
 */
export class LintError extends Error {
  readonly code: 'LINT_IO_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'LintError';
    this.code = 'LINT_IO_ERROR';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compat aliases — callers that imported the old flow-centric names
// continue to work without changes.
// ---------------------------------------------------------------------------

/** @deprecated Use {@link LintReport} — renamed as part of race/runner/baton vocabulary. */
export type LintIssue = LintFinding;

// ---------------------------------------------------------------------------
// README section headings — §7.4
//
// Sections 1–5 are required (missing → ERROR).
// Sections 6–8 are recommended (missing → WARN).
//
// Headings are matched case-insensitively against lines that start with a
// markdown heading marker (`#`) so that both `## Foo` and `# Foo` match.
// ---------------------------------------------------------------------------

const README_ERROR_SECTIONS: ReadonlyArray<{ heading: string; code: string }> = [
  { heading: 'What it does',               code: 'README_MISSING_WHAT_IT_DOES' },
  { heading: 'Sample output',              code: 'README_MISSING_SAMPLE_OUTPUT' },
  { heading: 'Estimated cost and duration', code: 'README_MISSING_COST_DURATION' },
  { heading: 'Install',                    code: 'README_MISSING_INSTALL' },
  { heading: 'Run',                        code: 'README_MISSING_RUN' },
];

const README_WARN_SECTIONS: ReadonlyArray<{ heading: string; code: string }> = [
  { heading: 'Configuration',  code: 'README_MISSING_CONFIGURATION' },
  { heading: 'Customization',  code: 'README_MISSING_CUSTOMIZATION' },
  { heading: 'License',        code: 'README_MISSING_LICENSE' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the path exists and is accessible. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a file as UTF-8 text, returning null on any failure. */
async function readTextFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse a JSON file, returning null on any failure.
 * The caller is responsible for narrowing the returned unknown value.
 */
async function readJson(p: string): Promise<unknown> {
  const raw = await readTextFile(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Safe property access on an unknown record. */
function prop(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Check (1): package.json exists and contains all required fields.
 *
 * Required top-level:  name, version (strict semver), type = "module", main
 * Required relay block: raceName, displayName, tags, estimatedCostUsd,
 *                       estimatedDurationMin, audience
 */
async function checkPackageJson(dir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const pkgPath = join(dir, 'package.json');

  if (!(await pathExists(pkgPath))) {
    findings.push({
      code: 'PKG_MISSING',
      message: 'package.json not found',
      path: 'package.json',
    });
    return findings;
  }

  const pkg = await readJson(pkgPath);

  if (pkg === null) {
    findings.push({
      code: 'PKG_INVALID_JSON',
      message: 'package.json is not valid JSON',
      path: 'package.json',
    });
    return findings;
  }

  // name
  const name = prop(pkg, 'name');
  if (typeof name !== 'string' || name.trim() === '') {
    findings.push({
      code: 'PKG_MISSING_NAME',
      message: 'package.json missing required field: name',
      path: 'package.json',
    });
  }

  // version — must be strict semver
  const version = prop(pkg, 'version');
  if (typeof version !== 'string' || semver.valid(version) === null) {
    findings.push({
      code: 'PKG_INVALID_VERSION',
      message: `package.json version "${String(version ?? '')}" is not valid strict semver`,
      path: 'package.json',
    });
  }

  // type: "module"
  if (prop(pkg, 'type') !== 'module') {
    findings.push({
      code: 'PKG_NOT_ESM',
      message: 'package.json must have "type": "module"',
      path: 'package.json',
    });
  }

  // main
  const main = prop(pkg, 'main');
  if (typeof main !== 'string' || main.trim() === '') {
    findings.push({
      code: 'PKG_MISSING_MAIN',
      message: 'package.json missing required field: main',
      path: 'package.json',
    });
  }

  // relay metadata block
  const relayBlock = prop(pkg, 'relay');

  if (relayBlock === undefined || relayBlock === null) {
    findings.push({
      code: 'PKG_MISSING_RELAY_BLOCK',
      message: 'package.json missing required "relay" metadata block',
      path: 'package.json',
    });
    return findings;
  }

  // raceName — machine-readable identifier for the race
  const raceName = prop(relayBlock, 'raceName');
  if (typeof raceName !== 'string' || raceName.trim() === '') {
    findings.push({
      code: 'PKG_MISSING_RACE_NAME',
      message: 'relay metadata block missing or empty: raceName',
      path: 'package.json',
    });
  }

  // displayName
  const displayName = prop(relayBlock, 'displayName');
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    findings.push({
      code: 'PKG_MISSING_DISPLAY_NAME',
      message: 'relay metadata block missing or empty: displayName',
      path: 'package.json',
    });
  }

  // tags — must be a non-empty array of strings
  const tags = prop(relayBlock, 'tags');
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    tags.some((t) => typeof t !== 'string')
  ) {
    findings.push({
      code: 'PKG_MISSING_TAGS',
      message: 'relay metadata block missing or invalid: tags (must be a non-empty string array)',
      path: 'package.json',
    });
  }

  // estimatedCostUsd — { min: number; max: number }
  const cost = prop(relayBlock, 'estimatedCostUsd');
  if (
    cost === null ||
    typeof cost !== 'object' ||
    typeof prop(cost, 'min') !== 'number' ||
    typeof prop(cost, 'max') !== 'number'
  ) {
    findings.push({
      code: 'PKG_MISSING_COST',
      message: 'relay metadata block missing or invalid: estimatedCostUsd (requires { min, max } numbers)',
      path: 'package.json',
    });
  }

  // estimatedDurationMin — { min: number; max: number }
  const duration = prop(relayBlock, 'estimatedDurationMin');
  if (
    duration === null ||
    typeof duration !== 'object' ||
    typeof prop(duration, 'min') !== 'number' ||
    typeof prop(duration, 'max') !== 'number'
  ) {
    findings.push({
      code: 'PKG_MISSING_DURATION',
      message: 'relay metadata block missing or invalid: estimatedDurationMin (requires { min, max } numbers)',
      path: 'package.json',
    });
  }

  // audience — must be a non-empty array of strings
  const audience = prop(relayBlock, 'audience');
  if (
    !Array.isArray(audience) ||
    audience.length === 0 ||
    audience.some((a) => typeof a !== 'string')
  ) {
    findings.push({
      code: 'PKG_MISSING_AUDIENCE',
      message: 'relay metadata block missing or invalid: audience (must be a non-empty string array)',
      path: 'package.json',
    });
  }

  return findings;
}

/**
 * Check (2): race.ts OR dist/race.js is present and has a default export.
 *
 * We do not dynamic-import user code; we check existence and grep for the
 * `export default` token syntactically.
 */
async function checkEntryPoint(dir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  const raceTs = join(dir, 'race.ts');
  const distRaceJs = join(dir, 'dist', 'race.js');

  const hasRaceTs = await pathExists(raceTs);
  const hasDistRaceJs = await pathExists(distRaceJs);

  if (!hasRaceTs && !hasDistRaceJs) {
    findings.push({
      code: 'ENTRY_MISSING',
      message: 'neither race.ts nor dist/race.js found — one must be present',
    });
    return findings;
  }

  // Prefer race.ts for the source check; fall back to dist/race.js.
  const candidate = hasRaceTs ? raceTs : distRaceJs;
  const relativePath = hasRaceTs ? 'race.ts' : 'dist/race.js';

  const source = await readTextFile(candidate);
  if (source === null) {
    findings.push({
      code: 'ENTRY_UNREADABLE',
      message: `${relativePath} exists but could not be read`,
      path: relativePath,
    });
    return findings;
  }

  // Must have a default export. Accepts any of:
  //   export default ...
  //   export { something as default }
  const hasDefaultExport =
    /\bexport\s+default\b/.test(source) ||
    /\bexport\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(source);

  if (!hasDefaultExport) {
    findings.push({
      code: 'ENTRY_NO_DEFAULT_EXPORT',
      message: `${relativePath} does not contain a default export — race.ts must "export default defineRace(...)"`,
      path: relativePath,
    });
  }

  return findings;
}

/**
 * Check (3): README.md contains the §7.4 ordered sections.
 *
 * Sections 1–5 missing → ERROR
 * Sections 6–8 missing → WARN
 *
 * Matching is case-insensitive against any line that starts with a markdown
 * heading marker (`#`) followed by optional whitespace and the section title.
 */
async function checkReadme(dir: string): Promise<{ errors: LintFinding[]; warnings: LintFinding[] }> {
  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  const readmePath = join(dir, 'README.md');

  if (!(await pathExists(readmePath))) {
    errors.push({
      code: 'README_MISSING',
      message: 'README.md not found',
      path: 'README.md',
    });
    return { errors, warnings };
  }

  const content = await readTextFile(readmePath);
  if (content === null) {
    errors.push({
      code: 'README_UNREADABLE',
      message: 'README.md exists but could not be read',
      path: 'README.md',
    });
    return { errors, warnings };
  }

  // Build a set of heading text found in the README (lowercase, trimmed).
  const headingPattern = /^#{1,6}\s+(.+)$/gm;
  const foundHeadings = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    if (match[1] !== undefined) {
      foundHeadings.add(match[1].trim().toLowerCase());
    }
  }

  for (const section of README_ERROR_SECTIONS) {
    if (!foundHeadings.has(section.heading.toLowerCase())) {
      errors.push({
        code: section.code,
        message: `README.md is missing required section: "${section.heading}" (§7.4 section 1–5)`,
        path: 'README.md',
      });
    }
  }

  for (const section of README_WARN_SECTIONS) {
    if (!foundHeadings.has(section.heading.toLowerCase())) {
      warnings.push({
        code: section.code,
        message: `README.md is missing recommended section: "${section.heading}" (§7.4 section 6–8)`,
        path: 'README.md',
      });
    }
  }

  return { errors, warnings };
}

/**
 * Check (4): prompts/ directory exists when any runner uses promptFile.
 *
 * We scan race.ts (or dist/race.js) for the string `promptFile` to detect
 * whether any runner references prompt files, then verify prompts/ exists.
 */
async function checkPromptsDirectory(dir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];

  // Determine which file to scan for promptFile references.
  const raceTs = join(dir, 'race.ts');
  const distRaceJs = join(dir, 'dist', 'race.js');

  const hasRaceTs = await pathExists(raceTs);
  const hasDistRaceJs = await pathExists(distRaceJs);

  if (!hasRaceTs && !hasDistRaceJs) {
    // Entry point absence is already reported by checkEntryPoint — skip here.
    return findings;
  }

  const candidate = hasRaceTs ? raceTs : distRaceJs;
  const source = await readTextFile(candidate);

  if (source === null) return findings;

  const referencesPromptFile = source.includes('promptFile');

  if (!referencesPromptFile) return findings;

  const promptsDir = join(dir, 'prompts');
  if (!(await pathExists(promptsDir))) {
    findings.push({
      code: 'PROMPTS_DIR_MISSING',
      message: 'race references promptFile but prompts/ directory does not exist',
      path: 'prompts',
    });
  }

  return findings;
}

/**
 * Check (5): schemas/ files, if any, can be listed and are readable.
 *
 * Full TypeScript compilation is left to the consuming build (tsc). Here we
 * only verify that any .ts files in schemas/ are non-empty and readable, so
 * we surface obviously broken files early.
 */
async function checkSchemas(dir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const schemasDir = join(dir, 'schemas');

  if (!(await pathExists(schemasDir))) return findings;

  let entries: string[];
  try {
    entries = await readdir(schemasDir);
  } catch {
    findings.push({
      code: 'SCHEMAS_DIR_UNREADABLE',
      message: 'schemas/ directory exists but could not be listed',
      path: 'schemas',
    });
    return findings;
  }

  const tsFiles = entries.filter((f) => f.endsWith('.ts'));

  for (const file of tsFiles) {
    const filePath = join(schemasDir, file);
    const content = await readTextFile(filePath);
    if (content === null) {
      findings.push({
        code: 'SCHEMA_FILE_UNREADABLE',
        message: `schemas/${file} exists but could not be read`,
        path: `schemas/${file}`,
      });
    } else if (content.trim() === '') {
      findings.push({
        code: 'SCHEMA_FILE_EMPTY',
        message: `schemas/${file} is empty`,
        path: `schemas/${file}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lint a race package directory against the §7 contract.
 *
 * Returns ok(LintReport) when the linter ran to completion — even if the
 * report contains errors and warnings. Returns err(LintError) only when an
 * unexpected internal failure (e.g., the directory is not accessible at all)
 * prevented the linter from running.
 *
 * @param dir  Absolute path to the race package root.
 */
export async function lintRacePackage(
  dir: string,
): Promise<Result<LintReport, LintError>> {
  // Guard: the directory must be accessible before we start any checks.
  if (!(await pathExists(dir))) {
    return err(new LintError(`race package directory not found: ${dir}`));
  }

  // Run all checks. Errors from individual checks are accumulated into the
  // report; they do not short-circuit subsequent checks.
  let pkgErrors: LintFinding[];
  let entryErrors: LintFinding[];
  let readmeResult: { errors: LintFinding[]; warnings: LintFinding[] };
  let promptsErrors: LintFinding[];
  let schemaErrors: LintFinding[];

  try {
    [pkgErrors, entryErrors, readmeResult, promptsErrors, schemaErrors] =
      await Promise.all([
        checkPackageJson(dir),
        checkEntryPoint(dir),
        checkReadme(dir),
        checkPromptsDirectory(dir),
        checkSchemas(dir),
      ]);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    return err(new LintError(`linter encountered an unexpected internal error: ${detail}`));
  }

  const report: LintReport = {
    errors: [
      ...pkgErrors,
      ...entryErrors,
      ...readmeResult.errors,
      ...promptsErrors,
      ...schemaErrors,
    ],
    warnings: [...readmeResult.warnings],
  };

  return ok(report);
}

/** @deprecated Use {@link lintRacePackage} — renamed as part of race/runner/baton vocabulary. */
export const lintFlowPackage = lintRacePackage;
