/**
 * Tests for `relay config set` — partial update and unknown-key rejection.
 *
 * TC-017: Setting one key preserves all other keys already in settings.
 * TC-018: Unknown key is rejected and settings.json is not modified.
 *
 * Both loadGlobalSettings and atomicWriteJson are mocked so no real disk I/O
 * occurs and real ~/.relay/settings.json is never touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before the module-under-test loads.
// ---------------------------------------------------------------------------

const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockAtomicWriteJson = vi.hoisted(() => vi.fn());
const mockGlobalSettingsPath = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  return {
    ...actual,
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    atomicWriteJson: (...args: unknown[]) => mockAtomicWriteJson(...args),
    globalSettingsPath: () => mockGlobalSettingsPath(),
  };
});

// Mock fs.mkdir so no real directory creation happens.
const mockMkdir = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks are registered.
// ---------------------------------------------------------------------------

import { ok, okAsync } from '@ganderbite/relay-core';
import { setAction } from '../../src/commands/config.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const FAKE_SETTINGS_PATH = '/tmp/relay-test-settings.json';

beforeEach(() => {
  vi.clearAllMocks();

  mockGlobalSettingsPath.mockReturnValue(FAKE_SETTINGS_PATH);
  mockMkdir.mockResolvedValue(undefined);
  mockAtomicWriteJson.mockReturnValue(okAsync(undefined));

  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TC-017: Partial update preserves all unrelated settings keys
// ---------------------------------------------------------------------------

describe('[TC-017] config set — partial update preserves unrelated keys', () => {
  it('updating provider leaves color and telemetry.enabled intact in the written object', async () => {
    // Simulate existing settings that include extra keys beyond the strict schema.
    // config.ts reads the raw object from loadGlobalSettings and passes it through
    // mergeSettingValue, which shallow-spreads — so any extra keys in the existing
    // object are preserved in the write payload.
    const existingSettings = {
      provider: 'claude-cli',
      telemetry: { enabled: true },
      color: 'always',
    };

    // Cast to RelaySettings — the real function would return the Zod-validated
    // subset, but here we inject richer state to verify the spread logic.
    mockLoadGlobalSettings.mockResolvedValue(
      ok(existingSettings as unknown as import('@ganderbite/relay-core').RelaySettings),
    );

    await setAction('provider', 'claude-cli', {});

    // atomicWriteJson must have been called exactly once.
    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();

    const [writtenPath, writtenValue] = mockAtomicWriteJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];

    // Written to the path returned by globalSettingsPath().
    expect(writtenPath).toBe(FAKE_SETTINGS_PATH);

    // The target key was updated.
    expect(writtenValue.provider).toBe('claude-cli');

    // Unrelated keys must survive the merge.
    expect(writtenValue.color).toBe('always');
    expect((writtenValue.telemetry as Record<string, unknown>)?.enabled).toBe(true);
  });

  it('updating color leaves provider intact in the written object', async () => {
    const existingSettings = { provider: 'claude-cli' };
    mockLoadGlobalSettings.mockResolvedValue(
      ok(existingSettings as import('@ganderbite/relay-core').RelaySettings),
    );

    await setAction('color', 'never', {});

    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [, writtenValue] = mockAtomicWriteJson.mock.calls[0] as [string, Record<string, unknown>];

    // The changed key reflects the new value.
    expect(writtenValue.color).toBe('never');

    // The untouched key is preserved.
    expect(writtenValue.provider).toBe('claude-cli');
  });

  it('updating telemetry.enabled leaves provider and color intact', async () => {
    const existingSettings = { provider: 'claude-cli', color: 'auto' };
    mockLoadGlobalSettings.mockResolvedValue(
      ok(existingSettings as unknown as import('@ganderbite/relay-core').RelaySettings),
    );

    await setAction('telemetry.enabled', 'false', {});

    expect(mockAtomicWriteJson).toHaveBeenCalledOnce();
    const [, writtenValue] = mockAtomicWriteJson.mock.calls[0] as [string, Record<string, unknown>];

    expect((writtenValue.telemetry as Record<string, unknown>)?.enabled).toBe(false);
    expect(writtenValue.provider).toBe('claude-cli');
    expect(writtenValue.color).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// TC-018: Unknown key is rejected; settings.json is not modified
// ---------------------------------------------------------------------------

describe('[TC-018] config set — unknown key rejected, settings not modified', () => {
  it('rejects an unknown key and never calls atomicWriteJson', async () => {
    // Even if settings load would succeed, we should never reach atomicWriteJson.
    mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'claude-cli' }));

    await expect(setAction('notARealKey', 'someValue', {})).rejects.toThrow('process.exit called');

    // Settings must not be written.
    expect(mockAtomicWriteJson).not.toHaveBeenCalled();

    // loadGlobalSettings must not be called either — key validation fires first.
    expect(mockLoadGlobalSettings).not.toHaveBeenCalled();
  });

  it('writes an error message for the unknown key to stderr', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'claude-cli' }));

    await expect(setAction('notARealKey', 'someValue', {})).rejects.toThrow('process.exit called');

    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');

    expect(stderrCalls).toContain("unknown key 'notARealKey'");
    expect(stderrCalls).toContain('valid keys:');
  });

  it('rejects another unknown key regardless of its value', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(null));

    await expect(setAction('__proto__', 'injection', {})).rejects.toThrow('process.exit called');

    expect(mockAtomicWriteJson).not.toHaveBeenCalled();
  });
});
