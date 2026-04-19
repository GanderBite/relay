/**
 * Visual identity module for the Relay CLI.
 *
 * This is the single source of truth for the brand grammar. Every command
 * that emits user-visible output imports constants and helpers from here —
 * never defines them inline.
 *
 * Voice rules (product spec §4.1–§4.2):
 *   - Calm, specific, honest. Senior engineer status update, not marketing.
 *   - State what happened; give exact numbers; name the next action.
 *   - "simply" is banned. No trailing exclamation marks. No emojis.
 *   - Numbers over adjectives: "2.1s" beats "quickly", "$0.38" beats "low cost".
 *   - Second person, present tense, active voice.
 *   - Every error names the specific cause and the exact next command.
 *
 * Color rules (product spec §4.3):
 *   - Green  — completed steps, successful auth, subscription billing confirmed.
 *   - Yellow — in-flight work, warnings, API-billing mode.
 *   - Red    — failed steps, broken auth, refused runs.
 *   - Gray   — pending steps, metadata, secondary text.
 *   - Colors are disabled when: NO_COLOR is set, --no-color was passed,
 *     or stdout is not a TTY. Pass-through (identity) in all disabled cases.
 */

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Color-disable detection
//
// Chalk respects NO_COLOR natively when chalk.level is checked, but we also
// need to handle non-TTY stdout and an explicit --no-color argv flag. Set
// chalk.level = 0 before any output if any disabled condition is true.
// ---------------------------------------------------------------------------

function isColorDisabled(): boolean {
  return (
    process.env['NO_COLOR'] !== undefined ||
    !process.stdout.isTTY ||
    process.argv.includes('--no-color')
  );
}

if (isColorDisabled()) {
  chalk.level = 0;
}

// ---------------------------------------------------------------------------
// The mark and wordmark (product spec §5.1, §5.3)
// ---------------------------------------------------------------------------

/** The Relay signature mark. Four nodes, three arrows. */
export const MARK = '●─▶●─▶●─▶●';

/**
 * The Relay wordmark. Two spaces between mark and name (product spec §5.3).
 * Always lowercase "relay" in the wordmark.
 */
export const WORDMARK = '●─▶●─▶●─▶●  relay';

// ---------------------------------------------------------------------------
// Symbol vocabulary (product spec §4.3)
//
// These are Unicode characters, not emoji. The symbol set is fixed — never
// add a symbol here that is not in the product spec vocabulary.
// ---------------------------------------------------------------------------

export const SYMBOLS = {
  /** Step or check succeeded. */
  ok: '✓',
  /** Step or check failed. */
  fail: '✕',
  /** Warning — user should read. */
  warn: '⚠',
  /** Spinner frames — step is running. Advance index on each tick. */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  /** Pending — step has not started. */
  pending: '○',
  /** Separator. */
  dot: '·',
  /** Arrow / flow direction. */
  arrow: '▶',
  /** Cancelled or paused mid-step. */
  cancelled: '⊘',
} as const;

// ---------------------------------------------------------------------------
// Color helpers
//
// Each helper returns the raw string when colors are disabled (chalk.level 0
// causes chalk to return the input unchanged, so no branching is needed here
// beyond the chalk.level assignment above).
// ---------------------------------------------------------------------------

/** Green — completed steps, successful auth, subscription billing confirmed. */
export function green(s: string): string {
  return chalk.green(s);
}

/** Yellow — in-flight work, warnings, API-billing mode. */
export function yellow(s: string): string {
  return chalk.yellow(s);
}

/** Red — failed steps, broken auth, refused runs. */
export function red(s: string): string {
  return chalk.red(s);
}

/** Gray — pending steps, metadata, secondary text. */
export function gray(s: string): string {
  return chalk.dim(s);
}

/** Bold — status labels, key values, emphasis without color. */
export function bold(s: string): string {
  return chalk.bold(s);
}

// ---------------------------------------------------------------------------
// Layout helpers
//
// These helpers produce the structural elements that recur across every
// command banner (product spec §6.3, §6.5, §6.6).
// ---------------------------------------------------------------------------

/** Width used for the horizontal rule and header/footer lines. */
const DEFAULT_WIDTH = 80;

/** Key column width for kvLine — matches the banner KV alignment in §6.3. */
const KV_KEY_WIDTH = 8;

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
 *   est      .40  ·  5 steps  ·  ~12 min
 */
export function kvLine(key: string, value: string): string {
  return `${key.padEnd(KV_KEY_WIDTH)}${value}`;
}
