#!/usr/bin/env node
/**
 * Find symbols and packages imported across multiple workspace packages.
 *
 * Usage: node find-cross-imports.js <repoPath>
 *
 * Outputs:
 *   { crossPackageImports: [{ importedPackage, usedBy: string[] }] }
 *
 * This gives Claude a pre-built dependency graph so the services step can
 * focus on describing cross-cutting concerns rather than grepping through
 * every file to discover which packages depend on which.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoPath = resolve(process.argv[2] ?? process.cwd());

function run(cmd: string, cwd = repoPath): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// Collect workspace package names and their directories
const pkgJsonPaths = run(
  `find . -name "package.json" ` +
    `-not -path "*/node_modules/*" ` +
    `-not -path "*/.git/*" ` +
    `-not -path "*/dist/*"`,
)
  .split('\n')
  .filter(Boolean);

interface PackageInfo {
  name: string;
  dir: string;
}

const workspacePkgs: PackageInfo[] = [];

for (const rel of pkgJsonPaths) {
  const full = join(repoPath, rel);
  const dir = full.replace(/[\\/]package\.json$/, '');
  const relDir = relative(repoPath, dir) || '.';
  try {
    const pkg = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
    if (Array.isArray(pkg['workspaces'])) continue; // skip workspace root
    if (relDir === '.') continue;
    if (typeof pkg['name'] === 'string' && pkg['name']) {
      workspacePkgs.push({ name: pkg['name'], dir: relDir });
    }
  } catch {}
}

// For each workspace package, find which OTHER packages import it
const crossPackageImports: Array<{ importedPackage: string; usedBy: string[] }> = [];

for (const { name: pkgName, dir: pkgDir } of workspacePkgs) {
  // Grep for import statements that reference this package name
  const grepOut = run(
    `grep -rl --include="*.ts" ` +
      `--exclude-dir=node_modules ` +
      `--exclude-dir=dist ` +
      `"from '${pkgName}" .`,
  );

  if (!grepOut) continue;

  const importingFiles = grepOut.split('\n').filter(Boolean);

  // Map files to their package directories
  const usedByDirs = new Set<string>();
  for (const f of importingFiles) {
    const absFile = join(repoPath, f.replace(/^\.\//, ''));
    // Find which workspace package this file belongs to
    for (const { dir: candidateDir } of workspacePkgs) {
      if (candidateDir === pkgDir) continue; // same package
      const absCandidate = join(repoPath, candidateDir);
      if (absFile.startsWith(absCandidate + '/')) {
        usedByDirs.add(candidateDir);
        break;
      }
    }
  }

  if (usedByDirs.size >= 1) {
    crossPackageImports.push({
      importedPackage: pkgName,
      usedBy: [...usedByDirs].sort(),
    });
  }
}

// Sort by number of dependents descending (most cross-cutting first)
crossPackageImports.sort((a, b) => b.usedBy.length - a.usedBy.length);

process.stdout.write(JSON.stringify({ crossPackageImports }, null, 2) + '\n');
