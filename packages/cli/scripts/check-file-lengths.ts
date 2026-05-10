import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const LINE_LIMIT = 400;

// Files that are intentionally thin re-export shims. They exist only to
// re-export symbols from a deeper module so callers use a stable import path.
// Adding a file here only makes sense when its entire content is export
// statements — adding substantive logic would require removing it from this
// list.
const SHIM_EXEMPTIONS = new Set([
  'src/progress.ts', // re-export shim for src/progress/index.ts
]);

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
  return content.split('\n').length;
}

function isShimExempt(relPath: string): boolean {
  return SHIM_EXEMPTIONS.has(relPath);
}

const packageDir = new URL('..', import.meta.url).pathname;
const srcDir = join(packageDir, 'src');

const files = collectTsFiles(srcDir);
const violations: Array<{ path: string; lines: number }> = [];

for (const file of files) {
  const relPath = relative(packageDir, file);
  if (isShimExempt(relPath)) continue;

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
