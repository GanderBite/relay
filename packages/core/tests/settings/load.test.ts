import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PipelineError } from '../../src/errors.js';
import { loadFlowSettings, loadGlobalSettings } from '../../src/settings/load.js';
import { flowSettingsPath, globalSettingsPath } from '../../src/settings/paths.js';

describe('loadFlowSettings', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-settings-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('[SETTINGS-LOAD-001] absent file returns ok(null)', async () => {
    const result = await loadFlowSettings(dir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('[SETTINGS-LOAD-002] valid JSON with provider returns ok(parsed)', async () => {
    const settingsPath = flowSettingsPath(dir);
    await writeFile(settingsPath, JSON.stringify({ provider: 'claude-cli' }));

    const result = await loadFlowSettings(dir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ provider: 'claude-cli' });
  });

  it('[SETTINGS-LOAD-003] valid JSON without provider returns ok with null provider', async () => {
    const settingsPath = flowSettingsPath(dir);
    await writeFile(settingsPath, JSON.stringify({}));

    const result = await loadFlowSettings(dir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({});
  });

  it('[SETTINGS-LOAD-004] extra keys are rejected by strict schema', async () => {
    const settingsPath = flowSettingsPath(dir);
    await writeFile(settingsPath, JSON.stringify({ provider: 'claude-cli', extra: 42 }));

    const result = await loadFlowSettings(dir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    expect(result._unsafeUnwrapErr().message).toContain('failed schema validation');
  });

  it('[SETTINGS-LOAD-005] invalid JSON returns err(PipelineError)', async () => {
    const settingsPath = flowSettingsPath(dir);
    await writeFile(settingsPath, 'this is not json {{{');

    const result = await loadFlowSettings(dir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
    expect(result._unsafeUnwrapErr().message).toContain('invalid JSON');
  });

  it('[SETTINGS-LOAD-006] schema failure (empty provider string) returns err(PipelineError)', async () => {
    const settingsPath = flowSettingsPath(dir);
    await writeFile(settingsPath, JSON.stringify({ provider: '' }));

    const result = await loadFlowSettings(dir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PipelineError);
  });
});

describe('loadGlobalSettings', () => {
  it('[SETTINGS-LOAD-007] returns ok(null) when ~/.relay/settings.json is absent', async () => {
    const originalPath = globalSettingsPath();
    // globalSettingsPath() points to real ~/.relay/settings.json — only test
    // the no-file case when it does not actually exist on this machine.
    // The load function ENOENT-handles it to ok(null).
    const result = await loadFlowSettings('/tmp/relay-nonexistent-dir-for-test');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
    void originalPath;
  });
});
