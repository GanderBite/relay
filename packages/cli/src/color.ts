/**
 * Color helpers for the Relay CLI.
 *
 * Chalk is initialized lazily via initColor() — the module-level chalk variable
 * is NOT set at load time. Call initColor() once in the CLI entry point before
 * any output is produced. Color helpers called before initColor() will throw.
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
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Chalk, type ChalkInstance } from 'chalk';

// ---------------------------------------------------------------------------
// Deferred chalk instance
//
// _chalk is undefined until initColor() is called. This prevents the settings
// file from being read at module load time, allowing tests to control the env
// before initialization.
// ---------------------------------------------------------------------------

let _chalk: ChalkInstance | undefined;
let _colorForced = false;

function requireChalk(): ChalkInstance {
  if (_chalk === undefined) {
    throw new Error('initColor() must be called before using color helpers');
  }
  return _chalk;
}

// ---------------------------------------------------------------------------
// Settings read — deferred into initColor(), never at module load
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitColorOptions {
  /** When true, disables color regardless of env or settings. Mirrors --no-color. */
  noColor: boolean;
}

/**
 * Initialize the chalk instance and apply color disable/force rules.
 * Must be called once before any color helper is used.
 *
 * Precedence:
 *   1. opts.noColor (--no-color flag) — always wins.
 *   2. NO_COLOR env variable — wins over settings.
 *   3. color='never' in ~/.relay/settings.json — wins over TTY auto-detect.
 *   4. !process.stdout.isTTY — fallback auto-disable.
 *   color='always' in settings forces chalk on regardless of TTY.
 */
export function initColor(opts: InitColorOptions): void {
  _colorForced = false;

  // Precedence 1: --no-color flag always wins.
  if (opts.noColor || process.argv.includes('--no-color')) {
    _chalk = new Chalk({ level: 0 });
    return;
  }

  // Precedence 2: NO_COLOR env variable wins over settings.
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    _chalk = new Chalk({ level: 0 });
    return;
  }

  // Precedence 3: explicit setting in ~/.relay/settings.json.
  const settingsColor = readSettingsColor();
  if (settingsColor === 'never') {
    _chalk = new Chalk({ level: 0 });
    return;
  }
  if (settingsColor === 'always') {
    _colorForced = true;
    _chalk = new Chalk({ level: 3 });
    return;
  }

  // Precedence 4: TTY auto-detect (settingsColor === 'auto' or null).
  if (!process.stdout.isTTY) {
    _chalk = new Chalk({ level: 0 });
    return;
  }

  // TTY detected — use chalk's default level (auto-detected from terminal caps).
  _chalk = new Chalk();
}

/**
 * Returns true when color output is currently enabled.
 * Returns false when initColor() has not been called yet.
 */
export function colorEnabled(): boolean {
  return _chalk !== undefined && _chalk.level > 0;
}

/**
 * Returns the active color mode as a string.
 * 'always'  — color is explicitly forced on via settings.json.
 * 'never'   — color is disabled.
 * 'auto'    — color is enabled by default TTY detection.
 * Requires initColor() to have been called first.
 */
export function colorMode(): 'always' | 'never' | 'auto' {
  const c = requireChalk();
  if (c.level === 0) return 'never';
  return _colorForced ? 'always' : 'auto';
}

/**
 * Programmatically disable color output.
 * Must be called after initColor(). Takes effect immediately for all
 * subsequent output since chalk.level is checked per-call.
 */
export function setColorDisabled(): void {
  _colorForced = false;
  _chalk = new Chalk({ level: 0 });
}

// ---------------------------------------------------------------------------
// Color helpers
//
// Each helper returns the raw string when colors are disabled (chalk.level 0
// causes chalk to return the input unchanged, so no branching is needed beyond
// the level assignment in initColor()).
// ---------------------------------------------------------------------------

/** Green — completed steps, successful auth, subscription billing confirmed. */
export function green(s: string): string {
  return requireChalk().green(s);
}

/** Yellow — in-flight work, warnings, API-billing mode. */
export function yellow(s: string): string {
  return requireChalk().yellow(s);
}

/** Red — failed steps, broken auth, refused runs. */
export function red(s: string): string {
  return requireChalk().red(s);
}

/** Gray — pending steps, metadata, secondary text. */
export function gray(s: string): string {
  return requireChalk().dim(s);
}

/** Bold — status labels, key values, emphasis without color. */
export function bold(s: string): string {
  return requireChalk().bold(s);
}

/** Dim — alias for gray; secondary text and metadata. */
export function dim(s: string): string {
  return requireChalk().dim(s);
}
