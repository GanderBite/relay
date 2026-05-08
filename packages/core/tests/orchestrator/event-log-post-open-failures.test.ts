/**
 * Post-open failure paths for EventLogWriter: handle.write(), handle.sync(),
 * and handle.close() rejections. These tests live in a separate file because
 * they need vi.mock('node:fs/promises') at module scope — and that mock would
 * conflict with the real-fs tests in event-log.test.ts.
 *
 * The mock delegates to the real implementation by default via vi.importActual.
 * Per-test, an openInterceptor function is registered before constructing the
 * writer; it receives the real FileHandle and patches the method under test to
 * reject. After each test, vi.restoreAllMocks() cleans up the spies on the
 * handle, and the interceptor is reset to null.
 */

import type { FileHandle } from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/logger.js';
import { EventLogWriter } from '../../src/orchestrator/event-log.js';

// ---------------------------------------------------------------------------
// Module-level interceptor slot. vi.mock is hoisted above all imports so the
// factory closure captures this variable at module evaluation time.
// ---------------------------------------------------------------------------

// The interceptor receives the real FileHandle after open() returns and may
// attach vi.fn() spies to it before the writer receives it.
let openInterceptor: ((h: FileHandle) => void) | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (openInterceptor !== null) {
        openInterceptor(handle);
      }
      return handle;
    },
  };
});

// ---------------------------------------------------------------------------
// Shared temp dir
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'relay-evlog-pof-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  openInterceptor = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// EVLOG-011: post-open write failure — stderr path
// ---------------------------------------------------------------------------

describe('EventLogWriter — post-open write failure (stderr path)', () => {
  it('[EVLOG-011] write() and flush() resolve when handle.write rejects; stderr contains "event-log: write failed"', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'write').mockRejectedValue(new Error('disk full'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-wfail', 0);
    await expect(writer.write(0, { type: 'text.delta', delta: 'x' })).resolves.toBeUndefined();
    await expect(writer.flush()).resolves.toBeUndefined();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(calls.some((m) => m.includes('event-log: write failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVLOG-012: post-open write failure — logger path
// ---------------------------------------------------------------------------

describe('EventLogWriter — post-open write failure (logger path)', () => {
  it('[EVLOG-012] write() and flush() resolve when handle.write rejects; logger.warn called with event-log.write_failed', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const mockWarn = vi.fn();
    const mockLogger = { warn: mockWarn } as unknown as Logger;

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'write').mockRejectedValue(new Error('disk full'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-wfail-log', 1, mockLogger);
    await expect(writer.write(0, { type: 'text.delta', delta: 'x' })).resolves.toBeUndefined();
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'event-log.write_failed',
        stepId: 'step-wfail-log',
        attempt: 1,
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// EVLOG-013: sync failure — stderr path
// ---------------------------------------------------------------------------

describe('EventLogWriter — sync failure (stderr path)', () => {
  it('[EVLOG-013] flush() resolves when handle.sync rejects; stderr contains "event-log: sync failed"', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync error'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-sfail', 0);
    await writer.write(0, { type: 'text.delta', delta: 'y' });
    await expect(writer.flush()).resolves.toBeUndefined();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(calls.some((m) => m.includes('event-log: sync failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVLOG-014: sync failure — logger path
// ---------------------------------------------------------------------------

describe('EventLogWriter — sync failure (logger path)', () => {
  it('[EVLOG-014] flush() resolves when handle.sync rejects; logger.warn called with event-log.sync_failed', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const mockWarn = vi.fn();
    const mockLogger = { warn: mockWarn } as unknown as Logger;

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync error'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-sfail-log', 2, mockLogger);
    await writer.write(0, { type: 'text.delta', delta: 'y' });
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'event-log.sync_failed',
        stepId: 'step-sfail-log',
        attempt: 2,
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// EVLOG-015: close failure — stderr path
// ---------------------------------------------------------------------------

describe('EventLogWriter — close failure (stderr path)', () => {
  it('[EVLOG-015] flush() resolves when handle.close rejects; stderr contains "event-log: close failed"', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'close').mockRejectedValue(new Error('close error'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-cfail', 0);
    await writer.write(0, { type: 'text.delta', delta: 'z' });
    await expect(writer.flush()).resolves.toBeUndefined();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(calls.some((m) => m.includes('event-log: close failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVLOG-016: close failure — logger path
// ---------------------------------------------------------------------------

describe('EventLogWriter — close failure (logger path)', () => {
  it('[EVLOG-016] flush() resolves when handle.close rejects; logger.warn called with event-log.close_failed', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const mockWarn = vi.fn();
    const mockLogger = { warn: mockWarn } as unknown as Logger;

    openInterceptor = (handle) => {
      vi.spyOn(handle, 'close').mockRejectedValue(new Error('close error'));
    };

    const writer = new EventLogWriter(eventsDir, 'step-cfail-log', 0, mockLogger);
    await writer.write(0, { type: 'text.delta', delta: 'z' });
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'event-log.close_failed',
        stepId: 'step-cfail-log',
        attempt: 0,
      }),
      expect.any(String),
    );
  });
});
