/**
 * Shell metacharacter sequences that indicate the caller intended a pipeline
 * or redirection that splitShell cannot model. Ordered longest-first so the
 * search stops at the most specific match.
 */
const SHELL_METACHARS = ['&&', '||', '$(', '`', '|', '>', '<', ';'] as const;

/**
 * Returns the first shell metacharacter sequence found in `run`, or
 * `undefined` if the string is safe to pass through splitShell.
 *
 * Exported so callers such as the dry-run command can surface the same
 * diagnostic without duplicating the detection logic.
 */
export function detectShellMetachars(run: string): string | undefined {
  for (const meta of SHELL_METACHARS) {
    if (run.includes(meta)) return meta;
  }
  return undefined;
}

/**
 * Builds the standard error message for shell-metacharacter rejection.
 * `kindLabel` identifies the step kind so the message names the correct
 * call site — e.g. "branch step:" vs "script step:".
 */
export function shellMetacharErrorMessage(kindLabel: 'script' | 'branch', run: string): string {
  return `${kindLabel} step: run="${run}" contains shell metacharacters. Use ['sh', '-c', '<pipeline>'] to run shell pipelines.`;
}

/**
 * Minimal shell-lexer: splits a command string into [cmd, ...args] respecting
 * single- and double-quoted segments. No shell interpolation is performed —
 * callers use shell: false for safety and determinism.
 */
export function splitShell(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === undefined) {
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && cmd[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (ch === '\\' && quote === "'" && cmd[i + 1] === "'") {
        current += "'";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
    i++;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
