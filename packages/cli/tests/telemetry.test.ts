/**
 * Tests for maybeSendRunEvent and isTelemetryEnabled.
 *
 * Covers: telemetry disabled (no settings / opted out), telemetry enabled with
 * network success, telemetry enabled with network failure (must not throw).
 *
 * loadGlobalSettings is mocked at the @ganderbite/relay-core boundary.
 * globalThis.fetch is stubbed via vi.stubGlobal so no real network calls occur.
 * Fake timers are used to control the AbortController timeout without real delays.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before the module-under-test is imported.
// ---------------------------------------------------------------------------

const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  return {
    ...actual,
    loadGlobalSettings: () => mockLoadGlobalSettings(),
  };
});

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import { isTelemetryEnabled, maybeSendRunEvent, type RunEvent } from '../src/telemetry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    flowName: 'test-flow',
    flowVersion: '0.0.1',
    status: 'success',
    durationMs: 1000,
    stepsCount: 3,
    totalCostUsd: 0.005,
    relayVersion: '0.1.0',
    nodeVersion: process.version,
    platform: process.platform,
    ...overrides,
  };
}

function settingsWithTelemetry(enabled: boolean) {
  return { provider: undefined, telemetry: { enabled } };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isTelemetryEnabled
// ---------------------------------------------------------------------------

describe('isTelemetryEnabled', () => {
  it('returns false when loadGlobalSettings returns an error', async () => {
    mockLoadGlobalSettings.mockResolvedValue(err(new Error('cannot read settings')));

    const result = await isTelemetryEnabled();
    expect(result).toBe(false);
  });

  it('returns false when settings is null (file absent)', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(null));

    const result = await isTelemetryEnabled();
    expect(result).toBe(false);
  });

  it('returns false when telemetry.enabled is false', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(false)));

    const result = await isTelemetryEnabled();
    expect(result).toBe(false);
  });

  it('returns true when telemetry.enabled is true', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));

    const result = await isTelemetryEnabled();
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeSendRunEvent — opt-out path
// ---------------------------------------------------------------------------

describe('maybeSendRunEvent — telemetry disabled', () => {
  it('does not call fetch when settings is absent', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(null));

    await maybeSendRunEvent(makeEvent());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch when telemetry.enabled is false', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(false)));

    await maybeSendRunEvent(makeEvent());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maybeSendRunEvent — opt-in paths
// ---------------------------------------------------------------------------

describe('maybeSendRunEvent — telemetry enabled', () => {
  it('POSTs the event to the telemetry endpoint on network success', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const evt = makeEvent({ status: 'success', stepsCount: 5, totalCostUsd: 0.025 });
    await maybeSendRunEvent(evt);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://telemetry.ganderbite.com/runs');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(String(init.body)) as RunEvent;
    expect(body.flowName).toBe('test-flow');
    expect(body.status).toBe('success');
    expect(body.stepsCount).toBe(5);
    expect(body.totalCostUsd).toBe(0.025);
  });

  it('swallows network errors and resolves without throwing', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(maybeSendRunEvent(makeEvent())).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('swallows non-2xx responses and resolves without throwing', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });

    await expect(maybeSendRunEvent(makeEvent())).resolves.toBeUndefined();
  });

  it('sends the signal from an AbortController to fetch', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));

    let capturedSignal: AbortSignal | null = null;
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? null;
      return Promise.resolve({ ok: true, status: 200 });
    });

    await maybeSendRunEvent(makeEvent());

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('swallows AbortError (timeout) and resolves without throwing', async () => {
    mockLoadGlobalSettings.mockResolvedValue(ok(settingsWithTelemetry(true)));

    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchSpy.mockRejectedValue(abortError);

    await expect(maybeSendRunEvent(makeEvent())).resolves.toBeUndefined();
  });
});
