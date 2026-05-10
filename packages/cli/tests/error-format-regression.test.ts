/**
 * Regression guard: every raw red(SYMBOLS.fail ...) call in a command file
 * must be accompanied by a comment explaining why formatError does not apply.
 *
 * Rule:
 *   If a source line matches /red\(/ AND contains "SYMBOLS.fail", then one of
 *   the five lines immediately above it (within the same file) must contain
 *   the sentinel comment "// usage-error: formatError does not apply".
 *
 * This test fails fast when a new PipelineError-style error is mistakenly
 * written as red(SYMBOLS.fail ...) instead of formatError(...).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = join(import.meta.dirname, '..', 'src', 'commands');
const SENTINEL = '// usage-error: formatError does not apply';

/**
 * Returns a list of offending line numbers — lines that contain
 * red(SYMBOLS.fail but whose preceding 5-line window lacks the sentinel.
 */
function findUnguardedRedCalls(source: string): number[] {
  const lines = source.split('\n');
  const offenders: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('red(') || !line.includes('SYMBOLS.fail')) continue;

    // Check the 5 lines above (or beginning of file) for the sentinel comment.
    const windowStart = Math.max(0, i - 5);
    const window = lines.slice(windowStart, i);
    const hasGuard = window.some((l) => l.includes(SENTINEL));

    if (!hasGuard) {
      offenders.push(i + 1); // 1-based line number for readability
    }
  }

  return offenders;
}

describe('error-format regression: red(SYMBOLS.fail) calls in command files', () => {
  it('every red(SYMBOLS.fail) call is annotated with the usage-error sentinel', async () => {
    const entries = await readdir(COMMANDS_DIR);
    const tsFiles = entries.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

    const violations: string[] = [];

    for (const filename of tsFiles) {
      const filepath = join(COMMANDS_DIR, filename);
      const source = await readFile(filepath, 'utf8');
      const offendingLines = findUnguardedRedCalls(source);

      for (const lineNo of offendingLines) {
        violations.push(`${filename}:${lineNo} — red(SYMBOLS.fail) missing "${SENTINEL}"`);
      }
    }

    expect(violations, `Unguarded red(SYMBOLS.fail) calls:\n${violations.join('\n')}`).toHaveLength(
      0,
    );
  });
});
