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
    if (ch === undefined) { i++; continue; }
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
