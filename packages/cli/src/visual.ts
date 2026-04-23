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
 *
 * Color disable precedence (no-color.org convention):
 *   1. --no-color flag         — always wins, overrides everything.
 *   2. NO_COLOR env variable   — wins over settings.
 *   3. color='never' in ~/.relay/settings.json — wins over TTY auto-detect.
 *   4. !process.stdout.isTTY  — fallback auto-disable when not a terminal.
 *   color='always' in settings forces color on even in non-TTY stdout.
 *
 * Column widths for step rows (product spec §6.5, §6.6, §11.3):
 *   STEP_NAME_WIDTH  = 16  — accommodates "designReview" (12) with margin
 *   MODEL_WIDTH      = 11  — accommodates "sonnet" (6) or "exit 1" (6) with margin
 *   DURATION_WIDTH   = 9   — accommodates "11m 42s" (7) with margin
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Color-disable detection
//
// Precedence (evaluated once at module load):
//   1. --no-color flag wins over everything.
//   2. NO_COLOR env variable wins over settings.
//   3. color='never' in ~/.relay/settings.json wins over TTY auto-detect.
//   4. !process.stdout.isTTY is the fallback auto-disable.
//   color='always' in settings forces chalk on regardless of TTY.
// ---------------------------------------------------------------------------

/** Read color setting from ~/.relay/settings.json synchronously at module load. */
function readSettingsColor(): 'auto' | 'always' | 'never' | null {
  try {
    const raw = readFileSync(join(homedir(), '.relay', 'settings.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const color = (parsed as Record<string, unknown>)['color'];
      if (color === 'auto' || color === 'always' || color === 'never') {
        return color;
      }
    }
  } catch {
    // File absent or unreadable — not an error, fall through to TTY detection.
  }
  return null;
}

/**
 * Module-level flag: true when color was explicitly forced on via
 * color='always' in settings.json (enables color in non-TTY stdout).
 */
let _colorForced = false;

// Apply color disable/force at module load.
(function applyColorSettings(): void {
  // Precedence 1: --no-color flag always wins.
  if (process.argv.includes('--no-color')) {
    chalk.level = 0;
    return;
  }

  // Precedence 2: NO_COLOR env variable wins over settings.
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    chalk.level = 0;
    return;
  }

  // Precedence 3: explicit setting in ~/.relay/settings.json.
  const settingsColor = readSettingsColor();
  if (settingsColor === 'never') {
    chalk.level = 0;
    return;
  }
  if (settingsColor === 'always') {
    _colorForced = true;
    if (chalk.level === 0) {
      chalk.level = 3;
    }
    return;
  }

  // Precedence 4: TTY auto-detect (settingsColor === 'auto' or null).
  if (!process.stdout.isTTY) {
    chalk.level = 0;
  }
})();

/**
 * Programmatically disable color output.
 * Must be called before any output is produced — chalk.level is checked
 * per-call, so this takes effect immediately for all subsequent output.
 * Used by the dispatcher's preAction hook when --no-color is detected at
 * runtime, where the module-load check has already run.
 */
export function setColorDisabled(): void {
  _colorForced = false;
  chalk.level = 0;
}

/**
 * Returns true when color output is currently enabled.
 * Reflects the current chalk.level (0 = disabled, >0 = enabled).
 */
export function enableColor(): boolean {
  return chalk.level > 0;
}

/**
 * Returns the active color mode as a string.
 * 'always'  — color is explicitly forced on (chalk.level forced to >0 via settings).
 * 'never'   — color is disabled (chalk.level = 0).
 * 'auto'    — color is enabled by default TTY detection.
 */
export function colorMode(): 'always' | 'never' | 'auto' {
  if (chalk.level === 0) return 'never';
  return _colorForced ? 'always' : 'auto';
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
 *   race     codebase-discovery v0.1.0
 *   input    .  (audience=both)
 *   run      f9c3a2  ·  2026-04-17 14:32
 *   bill     subscription (max)  ·  no api charges
 *   est      $0.40  ·  5 runners  ·  ~12 min
 */
export function kvLine(key: string, value: string): string {
  return `${key.padEnd(KV_KEY_WIDTH)}${value}`;
}

// ---------------------------------------------------------------------------
// Runner-row column widths (product spec §6.5, §6.6, §11.3)
//
// These are exported so banner.ts and progress.ts share identical column sizes
// and never drift apart. The spec shows:
//   ✓ inventory       sonnet     2.1s     $0.005
//   ✕ designReview    exit 1     0.2s
// ---------------------------------------------------------------------------

/** Runner name column width — padEnd to this value before the model column. */
export const STEP_NAME_WIDTH = 16;

/** Model column width — padEnd to this value before the duration column. */
export const MODEL_WIDTH = 11;

/** Duration column width — padEnd to this value before the tokens/cost column. */
export const DURATION_WIDTH = 9;

/**
 * Compose a banner header line from race name, run id, and an optional status symbol.
 * Produces: `●─▶●─▶●─▶●  <raceName> · <runId>  <symbol>` (symbol omitted when absent).
 *
 * Use this instead of string-replacing WORDMARK, which breaks when race names
 * contain "relay" or when WORDMARK changes.
 *
 * Examples (product spec §6.5, §6.6):
 *   raceHeader('codebase-discovery', 'f9c3a2', '✓')
 *   → '●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✓'
 */
export function raceHeader(raceName: string, runId: string, symbol?: string): string {
  const base = `${MARK}  ${raceName} ${SYMBOLS.dot} ${runId}`;
  return symbol !== undefined ? `${base}  ${symbol}` : base;
}

/** @deprecated Use raceHeader — kept for backward compatibility. */
export const flowHeader = raceHeader;
