/** Two-space indent for body lines. */
export const INDENT = '  ';

/** Separator between the headline block and remediations. */
export const BLANK = '';

/** Render a remediation line as `  → <command>`. */
export function remediation(command: string): string {
  return `${INDENT}→ ${command}`;
}
