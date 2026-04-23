/**
 * Layout constants and helper functions for the Relay CLI.
 *
 * Column widths, padding constants, and the structural element helpers
 * (rule, header, footer, kvLine) that recur across every command banner.
 *
 * This module may import from color.ts for chalk usage but must not import
 * from brand.ts — layout concerns are kept separate from brand constants.
 * It must not trigger a settings read at module load time.
 *
 * Column widths for step rows (product spec §6.5, §6.6, §11.3):
 *   STEP_NAME_WIDTH  = 16  — accommodates "designReview" (12) with margin
 *   MODEL_WIDTH      = 11  — accommodates "sonnet" (6) or "exit 1" (6) with margin
 *   DURATION_WIDTH   = 9   — accommodates "11m 42s" (7) with margin
 */

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Width used for the horizontal rule and header/footer lines. */
const DEFAULT_WIDTH = 80;

/** Key column width for kvLine — matches the banner KV alignment in §6.3. */
const KV_KEY_WIDTH = 8;

/** Runner name column width — padEnd to this value before the model column. */
export const STEP_NAME_WIDTH = 16;

/** Model column width — padEnd to this value before the duration column. */
export const MODEL_WIDTH = 11;

/** Duration column width — padEnd to this value before the tokens/cost column. */
export const DURATION_WIDTH = 9;

// ---------------------------------------------------------------------------
// Layout helpers
//
// These helpers produce the structural elements that recur across every
// command banner (product spec §6.3, §6.5, §6.6).
// ---------------------------------------------------------------------------

/**
 * A horizontal rule of `─` (U+2500) characters.
 * Default width is 80 columns.
 */
export function rule(width: number = DEFAULT_WIDTH): string {
  return '─'.repeat(width);
}

/**
 * A header line — the text surrounded by horizontal rules.
 * Used for section headings in multi-section output.
 */
export function header(text: string): string {
  return `${rule()}\n${text}\n${rule()}`;
}

/**
 * A footer line — the text preceded by a horizontal rule.
 * Used for closing blocks in command output.
 */
export function footer(text: string): string {
  return `${rule()}\n${text}`;
}

/**
 * A key-value line for the aligned banner KV block (product spec §6.3).
 *
 * The key is left-padded to KV_KEY_WIDTH (8) characters so that values
 * align vertically across rows:
 *
 *   flow     codebase-discovery v0.1.0
 *   input    .  (audience=both)
 *   run      f9c3a2  ·  2026-04-17 14:32
 *   bill     subscription (max)  ·  no api charges
 *   est      $0.40  ·  5 steps  ·  ~12 min
 */
export function kvLine(key: string, value: string): string {
  return `${key.padEnd(KV_KEY_WIDTH)}${value}`;
}
