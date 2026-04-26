/**
 * Color helpers for the Relay CLI.
 *
 * Chalk is initialized lazily via initColor() — the module-level state variable
 * is NOT set at load time. Call initColor() once in the CLI entry point before
 * any output is produced.
 *
 * If a color helper is called before initColor() (e.g. in tests), the
 * requireChalk() fallback auto-initializes with chalk's default env detection
 * (NO_COLOR / FORCE_COLOR honored; ~/.relay/settings.json is NOT consulted on
 * this path). This is a test-only escape hatch — production code always goes
 * through initColor().
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
import { z } from '@ganderbite/relay-core';
import { Chalk, type ChalkInstance } from 'chalk';

// Validates only the `color` field; ignores all other settings fields.
const ColorSettingsSchema = z
  .object({
    color: z.enum(['auto', 'always', 'never']).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Deferred state
//
// _state is undefined until initColor() is called. This prevents the settings
// file from being read at module load time, allowing tests to control the env
// before initialization.
//
// Collapsing the chalk instance and the color mode into a single struct ensures
// that the mode is always set in the same assignment that sets the level — one
// write site, one read site, no drift between the two.
// ---------------------------------------------------------------------------

let _state: { chalk: ChalkInstance; mode: 'always' | 'never' | 'auto' } | undefined;

function requireChalk(): ChalkInstance {
  if (_state === undefined) {
    // Auto-initialize with chalk's default env detection when initColor() has
    // not been called yet. This is a test-only escape hatch: chalk's own
    // NO_COLOR / FORCE_COLOR env variables are honored, but ~/.relay/settings.json
    // is NOT consulted on this path. Do not rely on this in production code.
    _state = { chalk: new Chalk(), mode: 'auto' };
  }
  return _state.chalk;
}

// ---------------------------------------------------------------------------
// Settings read — deferred into initColor(), never at module load
// ---------------------------------------------------------------------------

function readSettingsColor(): 'auto' | 'always' | 'never' | null {
  try {
    const raw = readFileSync(join(homedir(), '.relay', 'settings.json'), 'utf8');
    const result = ColorSettingsSchema.safeParse(JSON.parse(raw));
    if (result.success) {
      return result.data.color ?? null;
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
  // Precedence 1: --no-color flag always wins. Commander normalizes --no-color
  // into opts.noColor before this function is called; no argv scan is needed.
  if (opts.noColor) {
    _state = { chalk: new Chalk({ level: 0 }), mode: 'never' };
    return;
  }

  // Precedence 2: NO_COLOR env variable wins over settings.
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    _state = { chalk: new Chalk({ level: 0 }), mode: 'never' };
    return;
  }

  // Precedence 3: explicit setting in ~/.relay/settings.json.
  const settingsColor = readSettingsColor();
  if (settingsColor === 'never') {
    _state = { chalk: new Chalk({ level: 0 }), mode: 'never' };
    return;
  }
  if (settingsColor === 'always') {
    _state = { chalk: new Chalk({ level: 3 }), mode: 'always' };
    return;
  }

  // Precedence 4: TTY auto-detect (settingsColor === 'auto' or null).
  if (!process.stdout.isTTY) {
    _state = { chalk: new Chalk({ level: 0 }), mode: 'never' };
    return;
  }

  // TTY detected — use chalk's default level (auto-detected from terminal caps).
  _state = { chalk: new Chalk(), mode: 'auto' };
}

/**
 * Returns true when color output is currently enabled.
 * Returns false when initColor() has not been called yet.
 */
export function colorEnabled(): boolean {
  return _state !== undefined && _state.chalk.level > 0;
}

/**
 * Returns the active color mode as a string.
 * 'always'  — color is explicitly forced on via settings.json.
 * 'never'   — color is disabled.
 * 'auto'    — color is enabled by default TTY detection.
 * Requires initColor() to have been called first.
 */
export function colorMode(): 'always' | 'never' | 'auto' {
  return _state?.mode ?? 'auto';
}

/**
 * Programmatically disable color output.
 * Must be called after initColor(). Takes effect immediately for all
 * subsequent output since chalk.level is checked per-call.
 */
export function setColorDisabled(): void {
  _state = { chalk: new Chalk({ level: 0 }), mode: 'never' };
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
