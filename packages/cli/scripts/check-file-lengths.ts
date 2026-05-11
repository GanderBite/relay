import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const LINE_LIMIT = 400;

// A re-export shim is a file whose entire substantive content consists of
// re-export statements. Such files are exempt from the line-length cap because
// they carry no logic — only stable import-path aliases.
//
// Detection: strip block comments, line comments, and blank lines, then
// require that every remaining line matches a bare re-export pattern. A file
// with no substantive lines at all (empty or comments-only) is NOT a shim.
const SHIM_EXPORT_RE = /^\s*export\s+(\{[^}]*\}|\*)\s+from\s+['"][^'"]+['"];?\s*$/;

function stripComments(source: string): string {
  // Remove block comments first, then line comments.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function isShimExempt(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf8');
  const stripped = stripComments(content);
  const substantiveLines = stripped
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  if (substantiveLines.length === 0) return false;
  return substantiveLines.every((l) => SHIM_EXPORT_RE.test(l));
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf8');
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

const packageDir = new URL('..', import.meta.url).pathname;
const srcDir = join(packageDir, 'src');

const files = collectTsFiles(srcDir);
const violations: Array<{ path: string; lines: number }> = [];

for (const file of files) {
  const relPath = relative(packageDir, file);
  if (isShimExempt(file)) continue;

  const lines = countLines(file);
  if (lines > LINE_LIMIT) {
    violations.push({ path: relPath, lines });
  }
}

if (violations.length === 0) {
  process.stdout.write(`✓ All CLI source files are within the ${LINE_LIMIT}-line cap.\n`);
  process.exit(0);
} else {
  violations.sort((a, b) => b.lines - a.lines);
  process.stderr.write(
    `✕ ${violations.length} file${violations.length === 1 ? '' : 's'} exceed the ${LINE_LIMIT}-line cap:\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.lines.toString().padStart(4)} lines  ${v.path}\n`);
  }
  process.stderr.write(
    `\nSplit or refactor the files above, then re-run: pnpm -F @ganderbite/relay lint:filesize\n`,
  );
  process.exit(1);
}
