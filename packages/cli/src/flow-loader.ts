/**
 * Flow loader — resolves a name or path to a compiled Flow and its package
 * metadata, following the §5.3.1 resolution order.
 *
 * Resolution order:
 *   1. Path-like argument (starts with ./, ../, / or contains /) — resolve
 *      to an absolute directory and import <abs>/dist/flow.js.
 *   2. Named flow in <cwd>/.relay/flows/<name>/ — import dist/flow.js.
 *   3. Named flow in <cwd>/node_modules/@ganderbite/flow-<name>/ — import
 *      dist/flow.js.
 *   4. Not found — return err instructing the user to run `relay install`.
 *
 * Returns Result<{ flow, dir, pkg }, FlowLoadError>.
 * Never throws — all failure paths are captured as err().
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ok, err } from '@relay/core';
import type { Result } from '@relay/core';
import type { Flow } from '@relay/core';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type FlowLoadCode = 'FLOW_NOT_FOUND' | 'FLOW_INVALID';

export class FlowLoadError extends Error {
  readonly code: FlowLoadCode;

  constructor(message: string, code: FlowLoadCode) {
    super(message);
    this.name = 'FlowLoadError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---------------------------------------------------------------------------
// Public return type
// ---------------------------------------------------------------------------

export interface LoadedFlow {
  flow: Flow<unknown>;
  dir: string;
  pkg: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Duck-type guard
//
// We can't use instanceof here — the module may come from a different package.
// Check the three structural fields that every compiled Flow must carry:
//   name   — string (from FlowSpec)
//   steps  — object/record (from FlowSpec)
//   graph  — object with successors/predecessors/topoOrder (from FlowGraph)
// ---------------------------------------------------------------------------

function isFlow(value: unknown): value is Flow<unknown> {
  if (value === null || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;

  if (typeof candidate['name'] !== 'string') return false;
  if (candidate['steps'] === null || typeof candidate['steps'] !== 'object') return false;

  const graph = candidate['graph'];
  if (graph === null || typeof graph !== 'object') return false;

  const g = graph as Record<string, unknown>;
  if (!(g['successors'] instanceof Map)) return false;
  if (!(g['predecessors'] instanceof Map)) return false;
  if (!Array.isArray(g['topoOrder'])) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the argument looks like a filesystem path rather than a
 * plain flow name. Mirrors the check in dispatcher.ts.
 */
function looksLikePath(nameOrPath: string): boolean {
  return (
    nameOrPath.startsWith('./') ||
    nameOrPath.startsWith('../') ||
    nameOrPath.startsWith('/') ||
    nameOrPath.includes('/')
  );
}

/**
 * Read and JSON-parse a package.json file at the given directory.
 * Returns the parsed object, or an empty record on any failure.
 */
async function readPkg(dir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Attempt to dynamic-import <dir>/dist/flow.js, duck-type the default export,
 * and return the LoadedFlow if valid.
 */
async function importFlow(
  dir: string,
  source: string,
): Promise<Result<LoadedFlow, FlowLoadError>> {
  const entryPath = join(dir, 'dist', 'flow.js');

  let mod: unknown;
  try {
    mod = await import(entryPath);
  } catch (importErr) {
    const detail =
      importErr instanceof Error ? importErr.message : String(importErr);
    return err(
      new FlowLoadError(
        `failed to import flow from ${entryPath}: ${detail}`,
        'FLOW_INVALID',
      ),
    );
  }

  // The compiled entry must default-export the Flow object.
  const defaultExport =
    mod !== null && typeof mod === 'object'
      ? (mod as Record<string, unknown>)['default']
      : undefined;

  if (!isFlow(defaultExport)) {
    return err(
      new FlowLoadError(
        `${entryPath} does not export a valid Flow — expected an object with ` +
          `name (string), steps (object), and graph (FlowGraph)`,
        'FLOW_INVALID',
      ),
    );
  }

  const pkg = await readPkg(dir);

  process.stderr.write(`[relay] flow resolved from ${source}: ${dir}\n`);

  return ok({ flow: defaultExport, dir, pkg });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a flow name or path to a compiled Flow and its package metadata.
 *
 * @param nameOrPath  Either a flow name (e.g. "codebase-discovery") or a
 *                    filesystem path (e.g. "./my-flow", "/abs/path/to/flow").
 * @param cwd         The working directory from which relative paths and the
 *                    .relay/flows and node_modules directories are resolved.
 */
export async function loadFlow(
  nameOrPath: string,
  cwd: string,
): Promise<Result<LoadedFlow, FlowLoadError>> {
  // ---- (1) Path-like: resolve to absolute and import directly ----
  if (looksLikePath(nameOrPath)) {
    const absDir = resolve(cwd, nameOrPath);
    return importFlow(absDir, 'path');
  }

  const name = nameOrPath;

  // ---- (2) Local .relay/flows/<name>/ ----
  const localDir = join(cwd, '.relay', 'flows', name);
  try {
    const localResult = await importFlow(localDir, '.relay/flows');
    if (localResult.isOk()) return localResult;
    // importFlow only fails here if the module import or duck-type check fails,
    // meaning the directory exists but the flow is invalid — surface that error
    // rather than silently falling through.
    //
    // We fall through only on the specific case where the directory does not
    // exist at all (import will throw a MODULE_NOT_FOUND-style error, which
    // importFlow catches and returns as FLOW_INVALID). Distinguish by checking
    // the error code: FLOW_INVALID from a missing file has "Cannot find module"
    // or "ERR_MODULE_NOT_FOUND" in its message.
    const loadErr = localResult.error;
    if (!isModuleNotFound(loadErr.message)) {
      return localResult;
    }
  } catch {
    // Should not reach here — importFlow never throws — but guard anyway.
  }

  // ---- (3) node_modules/@ganderbite/flow-<name>/ ----
  const nmDir = join(cwd, 'node_modules', `@ganderbite/flow-${name}`);
  try {
    const nmResult = await importFlow(nmDir, 'node_modules');
    if (nmResult.isOk()) return nmResult;
    const loadErr = nmResult.error;
    if (!isModuleNotFound(loadErr.message)) {
      return nmResult;
    }
  } catch {
    // Should not reach here.
  }

  // ---- (4) Not found ----
  return err(
    new FlowLoadError(
      `flow "${name}" is not installed — run \`relay install ${name}\` to install it`,
      'FLOW_NOT_FOUND',
    ),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when an import error message indicates the module file was not
 * found (as opposed to a runtime error inside the module itself).
 */
function isModuleNotFound(message: string): boolean {
  return (
    message.includes('ERR_MODULE_NOT_FOUND') ||
    message.includes('Cannot find module') ||
    message.includes('MODULE_NOT_FOUND') ||
    message.includes('no such file') ||
    message.includes('ENOENT')
  );
}
