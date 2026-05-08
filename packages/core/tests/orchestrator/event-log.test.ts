import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord } from '../../src/orchestrator/event-log.js';
import { EventLogWriter } from '../../src/orchestrator/event-log.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'relay-event-log-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNdjson(content: string): EventRecord[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

// ISO-8601 datetime string check — accepts the output of new Date().toISOString()
function isIso8601(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s);
}

// ---------------------------------------------------------------------------
// Happy path — write three events, flush, read back and validate
// ---------------------------------------------------------------------------

describe('EventLogWriter — happy path', () => {
  it('[EVLOG-001] writes three events and produces valid NDJSON with incrementing seq', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-a', 0);

    await writer.write(0, { type: 'turn.start', turn: 1 });
    await writer.write(1, { type: 'text.delta', delta: 'hello' });
    await writer.write(2, { type: 'turn.end', turn: 1 });
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-a.jsonl'), 'utf8');
    const records = parseNdjson(raw);

    expect(records).toHaveLength(3);

    // seq increments from 0
    expect(records[0]?.seq).toBe(0);
    expect(records[1]?.seq).toBe(1);
    expect(records[2]?.seq).toBe(2);

    // ts is an ISO-8601 string
    for (const record of records) {
      expect(typeof record.ts).toBe('string');
      expect(isIso8601(record.ts)).toBe(true);
    }

    // attempt is preserved
    for (const record of records) {
      expect(record.attempt).toBe(0);
    }

    // event content matches what was passed
    expect(records[0]?.event).toEqual({ type: 'turn.start', turn: 1 });
    expect(records[1]?.event).toEqual({ type: 'text.delta', delta: 'hello' });
    expect(records[2]?.event).toEqual({ type: 'turn.end', turn: 1 });
  });

  it('[EVLOG-002] attempt number is stored on every record', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-b', 3);
    await writer.write(0, { type: 'text.delta', delta: 'x' });
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-b.jsonl'), 'utf8');
    const records = parseNdjson(raw);

    expect(records[0]?.attempt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// raw field gating
// ---------------------------------------------------------------------------

describe('EventLogWriter — raw field gating', () => {
  it('[EVLOG-003] write() without raw produces a record with no raw field', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-raw', 0);
    await writer.write(0, { type: 'text.delta', delta: 'no-raw' });
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-raw.jsonl'), 'utf8');
    const records = parseNdjson(raw);

    expect(records[0]).not.toHaveProperty('raw');
  });

  it('[EVLOG-004] write() with raw={foo:1} produces a record with raw={foo:1}', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-raw2', 0);
    await writer.write(0, { type: 'text.delta', delta: 'with-raw' }, { foo: 1 });
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-raw2.jsonl'), 'utf8');
    const records = parseNdjson(raw);

    expect(records[0]?.raw).toEqual({ foo: 1 });
  });

  it('[EVLOG-005] write() with raw=undefined produces a record with no raw field', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-raw3', 0);
    await writer.write(0, { type: 'text.delta', delta: 'explicit-undefined' }, undefined);
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-raw3.jsonl'), 'utf8');
    const records = parseNdjson(raw);

    expect(records[0]).not.toHaveProperty('raw');
  });
});

// ---------------------------------------------------------------------------
// flush() before any write — must be a no-op
// ---------------------------------------------------------------------------

describe('EventLogWriter — flush before any write', () => {
  it('[EVLOG-006] flush() on a fresh writer resolves normally without error', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    const writer = new EventLogWriter(eventsDir, 'step-flush', 0);
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// write() when the target directory does not exist
// ---------------------------------------------------------------------------

describe('EventLogWriter — missing directory', () => {
  it('[EVLOG-007] write() resolves normally when the events directory does not exist', async () => {
    // Suppress the stderr output produced by the caught open() failure
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const nonExistentDir = join(tmpDir, 'no-such-dir');
    // Do NOT create nonExistentDir — open() will fail

    const writer = new EventLogWriter(nonExistentDir, 'step-missing', 0);
    await expect(writer.write(0, { type: 'text.delta', delta: 'x' })).resolves.toBeUndefined();
    // write() is fire-and-forget; flush() drains the in-flight queue so the
    // open() failure has been observed by the time we assert on stderr.
    await writer.flush();

    // The error was reported on stderr
    expect(stderrSpy).toHaveBeenCalled();
    const call = stderrSpy.mock.calls[0];
    const msg = String(call?.[0] ?? '');
    expect(msg).toContain('event-log: open failed');
  });

  it('[EVLOG-008] subsequent write() calls after open failure also resolve normally', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const nonExistentDir = join(tmpDir, 'no-such-dir-2');

    const writer = new EventLogWriter(nonExistentDir, 'step-missing2', 0);
    // First write triggers the open attempt and fails
    await writer.write(0, { type: 'text.delta', delta: 'a' });
    // Subsequent writes should also silently no-op (handle stays null)
    await expect(writer.write(1, { type: 'text.delta', delta: 'b' })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error isolation — file in place of the events directory
// ---------------------------------------------------------------------------

describe('EventLogWriter — error isolation', () => {
  it('[EVLOG-009] open() fails when the events path is a file; write() and flush() do not throw', async () => {
    // Suppress the stderr error output
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Create a regular FILE at the events directory path so open() fails
    const eventsFile = join(tmpDir, 'events-as-file');
    await writeFile(eventsFile, 'not a directory');

    const writer = new EventLogWriter(eventsFile, 'step-iso', 0);

    // write() must not throw even though open() will fail (ENOTDIR or EEXIST)
    await expect(writer.write(0, { type: 'text.delta', delta: 'x' })).resolves.toBeUndefined();

    // flush() after a failed open must also resolve normally
    await expect(writer.flush()).resolves.toBeUndefined();

    // The write error was reported on stderr (at least once)
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('[EVLOG-010] flush() resolves normally even after error isolation scenario', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const eventsFile = join(tmpDir, 'events-as-file-2');
    await writeFile(eventsFile, 'not a directory');

    const writer = new EventLogWriter(eventsFile, 'step-iso2', 0);
    // trigger open failure
    await writer.write(0, { type: 'text.delta', delta: 'y' });
    // flush on a writer that never opened must be a no-op
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fallback record on JSON.stringify failure (circular reference)
// ---------------------------------------------------------------------------

describe('EventLogWriter — serialization fallback', () => {
  it('[EVLOG-017] write() with a circular-reference event produces a fallback NDJSON line with _serialization: "failed"', async () => {
    const eventsDir = join(tmpDir, 'events');
    await mkdir(eventsDir, { recursive: true });

    // Suppress stderr — the write catch path also invokes #report which writes stderr
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Construct a circular-reference payload that JSON.stringify will throw on.
    // The event satisfies the InvocationEvent discriminant but the input field
    // creates the cycle; JSON.stringify throws TypeError on circular structures.
    const circularInput: Record<string, unknown> = {};
    circularInput['self'] = circularInput;
    const circularEvent = {
      type: 'tool.call' as const,
      name: 'bash',
      input: circularInput,
    };

    const writer = new EventLogWriter(eventsDir, 'step-circular', 0);
    await writer.write(5, circularEvent);
    await writer.flush();

    const raw = await readFile(join(eventsDir, 'step-circular.jsonl'), 'utf8');
    const lines = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Exactly one fallback line on disk
    expect(lines).toHaveLength(1);

    const fallback = lines[0];
    expect(fallback).toBeDefined();
    expect(fallback?.['seq']).toBe(5);
    expect(fallback?.['attempt']).toBe(0);
    expect(typeof fallback?.['ts']).toBe('string');
    expect((fallback?.['event'] as Record<string, unknown>)?.['type']).toBe('tool.call');
    expect(fallback?.['_serialization']).toBe('failed');
    // The original (un-serializable) payload must not be present under event.name or event.input
    expect(fallback?.['event']).not.toHaveProperty('name');
    expect(fallback?.['event']).not.toHaveProperty('input');
  });
});
