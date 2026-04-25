#!/usr/bin/env node
/**
 * List top-level exported symbols from TypeScript source files.
 *
 * Usage: node list-exports.js <repoPath>
 *
 * Outputs:
 *   { exports: [{ name, file, exportKind }] }
 *
 * exportKind is one of: class | function | const | interface | type | enum
 *
 * This gives Claude a pre-built list of exported names + file paths so the
 * entities step can focus on classifying (model/service/controller/util) and
 * writing summaries rather than discovering symbols across many Read calls.
 */
import { execSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const repoPath = resolve(process.argv[2] ?? process.cwd());

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// Grep for top-level export declarations across all .ts files
// Pattern matches: export class|function|const|interface|type|enum|abstract class
const raw = run(
  `grep -rn --include="*.ts" ` +
    `--exclude-dir=node_modules ` +
    `--exclude-dir=dist ` +
    `--exclude-dir=".git" ` +
    `-E "^export (default )?(abstract class|class|function|const|interface|type|enum) [A-Z]" .`,
);

interface ExportEntry {
  name: string;
  file: string;
  exportKind: string;
}

const exports: ExportEntry[] = [];
const seen = new Set<string>();

for (const line of raw.split('\n')) {
  if (!line.trim()) continue;

  // Format: ./path/to/file.ts:42:export class Foo ...
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) continue;
  const afterFirst = line.indexOf(':', colonIdx + 1);
  if (afterFirst === -1) continue;

  const filePath = line.slice(0, colonIdx);
  const declLine = line.slice(afterFirst + 1).trim();

  const match =
    /^export (?:default )?(?:abstract )?(class|function|const|interface|type|enum) (\w+)/.exec(
      declLine,
    );
  if (!match) continue;

  const [, exportKind, name] = match;
  if (!exportKind || !name) continue;
  // Skip lowercase-leading (usually not public API)
  if (name[0] !== name[0]?.toUpperCase()) continue;

  const key = `${filePath}:${name}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const relFile = relative(repoPath, filePath.startsWith('./') ? filePath.slice(2) : filePath);
  exports.push({ name, file: relFile.startsWith('.') ? relFile : relFile, exportKind });
}

// Sort by file then name for stable output
exports.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

process.stdout.write(JSON.stringify({ exports }, null, 2) + '\n');
