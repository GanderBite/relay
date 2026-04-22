/**
 * relay config — view or edit global Relay settings (~/.relay/settings.json).
 *
 * Subcommands (parsed from process.argv):
 *   relay config list            print all settings (default when no subcommand)
 *   relay config get <key>       print one value, or "(not set)" when absent
 *   relay config set <key> <v>   write one value atomically
 *
 * Supported keys:
 *   provider          string — one of: claude-cli
 *   telemetry.enabled boolean — accepts "true"/"false" strings
 *   color             "auto" | "always" | "never"
 *
 * Reads via loadGlobalSettings() from @relay/core.
 * Writes via atomicWriteJson() from @relay/core.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  atomicWriteJson,
  globalSettingsPath,
  loadGlobalSettings,
  type RelaySettings,
} from '@relay/core';

import { gray, green, MARK, red, SYMBOLS } from '../visual.js';

// ---------------------------------------------------------------------------
// Valid keys and their constraints
// ---------------------------------------------------------------------------

const VALID_PROVIDERS = ['claude-cli'] as const;
const VALID_COLORS = ['auto', 'always', 'never'] as const;

/** All keys this command accepts, in display order. */
const VALID_KEYS = ['provider', 'telemetry.enabled', 'color'] as const;
type ValidKey = (typeof VALID_KEYS)[number];

/** Column width for the key in `config list` output. */
const KEY_COL_WIDTH = 18;

// ---------------------------------------------------------------------------
// Subcommand routing — parse from process.argv
// ---------------------------------------------------------------------------

/**
 * Extract the subcommand and its arguments from process.argv.
 * process.argv for `relay config set provider claude-cli` is:
 *   [..., 'config', 'set', 'provider', 'claude-cli']
 */
function parseSubcommand(): { sub: string; subArgs: string[] } {
  const argv = process.argv;
  const configIdx = argv.lastIndexOf('config');
  if (configIdx === -1 || configIdx + 1 >= argv.length) {
    return { sub: 'list', subArgs: [] };
  }
  const after = argv.slice(configIdx + 1).filter((a) => !a.startsWith('--'));
  if (after.length === 0) {
    return { sub: 'list', subArgs: [] };
  }
  const sub = after[0] ?? 'list';
  return { sub, subArgs: after.slice(1) };
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

function isValidKey(key: string): key is ValidKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Value coercion and validation
// ---------------------------------------------------------------------------

/**
 * Validate and coerce a string value for the given key.
 * Returns { ok: true, value } on success or { ok: false, reason } on failure.
 */
function coerceValue(
  key: ValidKey,
  raw: string,
): { ok: true; value: string | boolean } | { ok: false; reason: string } {
  switch (key) {
    case 'provider': {
      if ((VALID_PROVIDERS as readonly string[]).includes(raw)) {
        return { ok: true, value: raw };
      }
      return {
        ok: false,
        reason: `unknown provider '${raw}'`,
      };
    }
    case 'telemetry.enabled': {
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'must be "true" or "false"' };
    }
    case 'color': {
      if ((VALID_COLORS as readonly string[]).includes(raw)) {
        return { ok: true, value: raw };
      }
      return {
        ok: false,
        reason: `must be one of: ${VALID_COLORS.join(', ')}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Settings object helpers
// ---------------------------------------------------------------------------

/**
 * Read a single key from a settings object.
 * Supports dotted paths: "telemetry.enabled" → settings.telemetry?.enabled
 */
function getSettingValue(settings: RelaySettings, key: ValidKey): string | boolean | undefined {
  if (key === 'telemetry.enabled') {
    const telemetry = (settings as Record<string, unknown>)['telemetry'];
    if (telemetry !== null && typeof telemetry === 'object' && !Array.isArray(telemetry)) {
      const val = (telemetry as Record<string, unknown>)['enabled'];
      if (typeof val === 'boolean') return val;
    }
    return undefined;
  }
  const val = (settings as Record<string, unknown>)[key];
  if (typeof val === 'string' || typeof val === 'boolean') return val;
  return undefined;
}

/**
 * Produce the merged settings object after setting key to value.
 * Supports dotted paths: "telemetry.enabled" → { telemetry: { enabled: v } }
 */
function mergeSettingValue(
  existing: RelaySettings,
  key: ValidKey,
  value: string | boolean,
): Record<string, unknown> {
  const obj = { ...(existing as Record<string, unknown>) };

  if (key === 'telemetry.enabled') {
    const existing_telemetry = obj['telemetry'];
    const existingTelObj =
      existing_telemetry !== null &&
      typeof existing_telemetry === 'object' &&
      !Array.isArray(existing_telemetry)
        ? (existing_telemetry as Record<string, unknown>)
        : {};
    obj['telemetry'] = { ...existingTelObj, enabled: value };
    return obj;
  }

  obj[key] = value;
  return obj;
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  process.stdout.write(`${MARK}  relay config\n`);
  process.stdout.write('\n');

  const result = await loadGlobalSettings();

  if (result.isErr()) {
    process.stderr.write(`${red(SYMBOLS.fail)} failed to load settings: ${result.error.message}\n`);
    process.exit(1);
  }

  const settings = result.value;

  if (settings === null) {
    process.stdout.write("no settings — run 'relay init'\n");
    return;
  }

  // Collect rows that are actually set.
  const rows: Array<{ key: string; val: string }> = [];

  for (const key of VALID_KEYS) {
    const val = getSettingValue(settings, key);
    if (val !== undefined) {
      rows.push({ key, val: String(val) });
    }
  }

  if (rows.length === 0) {
    process.stdout.write("no settings — run 'relay init'\n");
    return;
  }

  for (const { key, val } of rows) {
    process.stdout.write(`${gray(key.padEnd(KEY_COL_WIDTH))}${val}\n`);
  }
}

async function cmdGet(key: string): Promise<void> {
  if (!isValidKey(key)) {
    printUnknownKey(key);
    process.exit(1);
  }

  const result = await loadGlobalSettings();

  if (result.isErr()) {
    process.stderr.write(`${red(SYMBOLS.fail)} failed to load settings: ${result.error.message}\n`);
    process.exit(1);
  }

  const settings = result.value;

  if (settings === null) {
    process.stdout.write('(not set)\n');
    return;
  }

  const val = getSettingValue(settings, key);
  if (val === undefined) {
    process.stdout.write('(not set)\n');
    return;
  }

  process.stdout.write(`${String(val)}\n`);
}

async function cmdSet(key: string, rawValue: string): Promise<void> {
  if (!isValidKey(key)) {
    printUnknownKey(key);
    process.exit(1);
  }

  const coerced = coerceValue(key, rawValue);
  if (!coerced.ok) {
    process.stderr.write(`${red(SYMBOLS.fail)} invalid value for ${key}: ${coerced.reason}\n`);
    process.exit(1);
  }

  // Load existing settings (null → treat as empty object).
  const loadResult = await loadGlobalSettings();
  if (loadResult.isErr()) {
    process.stderr.write(
      `${red(SYMBOLS.fail)} failed to load settings: ${loadResult.error.message}\n`,
    );
    process.exit(1);
  }

  const existing: RelaySettings = loadResult.value ?? ({} as RelaySettings);
  const merged = mergeSettingValue(existing, key, coerced.value);

  // Ensure ~/.relay/ exists.
  const settingsPath = globalSettingsPath();
  const relayDir = path.dirname(settingsPath);
  await fs.mkdir(relayDir, { recursive: true });

  const writeResult = await atomicWriteJson(settingsPath, merged);
  if (writeResult.isErr()) {
    process.stderr.write(
      `${red(SYMBOLS.fail)} failed to write settings: ${writeResult.error.message}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${green(SYMBOLS.ok)} ${key} = ${String(coerced.value)}\n`);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function printUnknownKey(key: string): void {
  process.stderr.write(`${red(SYMBOLS.fail)} unknown key '${key}'\n`);
  process.stderr.write('\n');
  process.stderr.write(`  valid keys: ${VALID_KEYS.join(', ')}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay config`.
 * Receives args=[] and opts from the dispatcher; subcommand is parsed from
 * process.argv directly (same pattern as runs.ts).
 */
export default async function configCommand(_args: unknown[], _opts: unknown): Promise<void> {
  const { sub, subArgs } = parseSubcommand();

  switch (sub) {
    case 'list': {
      await cmdList();
      break;
    }
    case 'get': {
      const key = subArgs[0] ?? '';
      if (key === '') {
        process.stderr.write(`${red(SYMBOLS.fail)} usage: relay config get <key>\n`);
        process.exit(1);
      }
      await cmdGet(key);
      break;
    }
    case 'set': {
      const key = subArgs[0] ?? '';
      const val = subArgs[1] ?? '';
      if (key === '' || val === '') {
        process.stderr.write(`${red(SYMBOLS.fail)} usage: relay config set <key> <value>\n`);
        process.exit(1);
      }
      await cmdSet(key, val);
      break;
    }
    default: {
      // Unrecognised subcommand — treat as 'list' with a warning, or fall
      // through to list output. Per spec, no subcommand → list.
      await cmdList();
      break;
    }
  }
}
