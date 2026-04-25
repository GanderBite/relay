#!/usr/bin/env node
/**
 * Scan a repository for workspace packages.
 *
 * Usage: node scan-packages.js <repoPath>
 *
 * Outputs a JSON object matching the InventorySchema shape:
 *   { packages: [{ path, name, language, entryPoints }] }
 *
 * What it does that Claude would otherwise spend many turns on:
 *   - Finds every package.json not under node_modules
 *   - Reads name, detects language (ts/py/go/rust/other)
 *   - Resolves entry points from package.json main/exports + common defaults
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoPath = resolve(process.argv[2] ?? process.cwd());

function run(cmd: string, cwd = repoPath): string {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function detectLanguage(dir: string): 'ts' | 'py' | 'go' | 'rust' | 'other' {
  if (existsSync(join(dir, 'tsconfig.json'))) return 'ts';
  const hasTsSrc = run(
    `find . -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" -maxdepth 4 | head -1`,
    dir,
  );
  if (hasTsSrc) return 'ts';
  const hasPy = run(`find . -name "*.py" -maxdepth 3 | head -1`, dir);
  if (hasPy) return 'py';
  if (existsSync(join(dir, 'go.mod'))) return 'go';
  if (existsSync(join(dir, 'Cargo.toml'))) return 'rust';
  return 'other';
}

function resolveEntryPoints(dir: string, pkg: Record<string, unknown>): string[] {
  const points: string[] = [];

  const main = pkg['main'];
  if (typeof main === 'string' && main) points.push(main);

  const candidates = ['src/index.ts', 'src/cli.ts', 'index.ts', 'src/index.js', 'index.js'];
  for (const c of candidates) {
    if (existsSync(join(dir, c)) && !points.includes(c)) points.push(c);
  }

  return points;
}

// Find all package.json files, skipping node_modules/.git/dist
const found = run(
  `find . -name "package.json" ` +
    `-not -path "*/node_modules/*" ` +
    `-not -path "*/.git/*" ` +
    `-not -path "*/dist/*" ` +
    `-not -path "*/.yarn/*"`,
)
  .split('\n')
  .filter(Boolean);

const packages: Array<{
  path: string;
  name: string;
  language: string;
  entryPoints: string[];
}> = [];

for (const rel of found) {
  const full = join(repoPath, rel);
  const dir = full.replace(/[\\/]package\.json$/, '');
  const relDir = relative(repoPath, dir) || '.';

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  } catch {
    continue;
  }

  // Skip workspace roots (they have a "workspaces" array)
  if (Array.isArray(pkg['workspaces'])) continue;
  // Skip the root itself
  if (relDir === '.') continue;

  packages.push({
    path: relDir,
    name: typeof pkg['name'] === 'string' ? pkg['name'] : relDir,
    language: detectLanguage(dir),
    entryPoints: resolveEntryPoints(dir, pkg),
  });
}

process.stdout.write(JSON.stringify({ packages }, null, 2) + '\n');
