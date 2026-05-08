/**
 * Tests for `relay logs --verbose` — event replay from events/*.jsonl fixture files.
 *
 * The command reads flags directly from process.argv, so tests must stub
 * process.argv before invoking logsCommand. process.cwd() is used to resolve
 * the runs directory, so tests stub it via vi.stubGlobal to point to a temp dir.
 *
 * The verbose path returns normally after rendering events. The non-verbose
 * path may call process.exit(0) or process.exit(1); process.exit is always
 * stubbed to prevent the test runner from dying.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import logsCommand from '../../src/commands/logs.js';
import { renderStreamingLine, renderVerboseEvent } from '../../src/verboseStream.js';

// ---------------------------------------------------------------------------
// Fixture data — 6 NDJSON event records matching the InvocationEvent union
// ---------------------------------------------------------------------------

const FIXTURE_RECORDS = [
  {
    seq: 0,
    ts: '2026-05-08T10:00:00.000Z',
    attempt: 1,
    event: {
      type: 'system.init',
      model: 'claude-opus-4-5',
      sessionId: 'sess1',
      tools: ['Bash'],
      mcpServers: [],
    },
  },
  {
    seq: 1,
    ts: '2026-05-08T10:00:01.000Z',
    attempt: 1,
    event: { type: 'turn.start', turn: 1 },
  },
  {
    seq: 2,
    ts: '2026-05-08T10:00:02.000Z',
    attempt: 1,
    event: { type: 'tool.call', name: 'Bash', input: { cmd: 'ls' } },
  },
  {
    seq: 3,
    ts: '2026-05-08T10:00:03.000Z',
    attempt: 1,
    event: { type: 'tool.result', name: 'Bash', ok: true },
  },
  {
    seq: 4,
    ts: '2026-05-08T10:00:04.000Z',
    attempt: 1,
    event: {
      type: 'usage',
      usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
  },
  {
    seq: 5,
    ts: '2026-05-08T10:00:05.000Z',
    attempt: 1,
    event: { type: 'stream.end', stopReason: 'end_turn', costUsd: 0.0012 },
  },
] as const;

const FIXTURE_NDJSON = FIXTURE_RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the run dir tree under the given base tmp dir for run id 'abc123'. */
async function mkRunDir(base: string): Promise<{ runDir: string; eventsDir: string }> {
  const runDir = join(base, '.relay', 'runs', 'abc123');
  const eventsDir = join(runDir, 'events');
  await mkdir(eventsDir, { recursive: true });
  // Write a minimal state.json so readFlowName succeeds.
  await writeFile(join(runDir, 'state.json'), JSON.stringify({ flowName: 'test-flow' }));
  return { runDir, eventsDir };
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'relay-logs-verbose-'));

  // Stub process.cwd() so logsCommand resolves runs under the temp dir.
  vi.stubGlobal('process', {
    ...process,
    cwd: () => tmpBase,
    // Keep the real argv stub-able per test — reset to a safe base here.
    argv: ['node', 'relay', 'logs', 'abc123'],
    // Stub exit so it never terminates the test runner.
    exit: vi.fn(() => {
      throw new Error('process.exit called');
    }),
    stdout: process.stdout,
    stderr: process.stderr,
    on: process.on.bind(process),
    emit: process.emit.bind(process),
    env: process.env,
  });

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. stdout output matches snapshot for a full fixture replay
// ---------------------------------------------------------------------------

describe('relay logs --verbose — full fixture replay', () => {
  it('[LOGS-VRB-001] replays all 6 fixture events and output matches snapshot', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    // Inject --verbose into process.argv.
    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    expect(output).toMatchSnapshot();
  });

  it('[LOGS-VRB-002] rendered lines match renderVerboseEvent applied to each fixture record', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    // Derive expected rendered lines from renderVerboseEvent — same function
    // the implementation uses, so this test asserts the contract without
    // hard-coding ANSI escape sequences or color details.
    for (const record of FIXTURE_RECORDS) {
      const line = renderVerboseEvent(record as Parameters<typeof renderVerboseEvent>[0]);
      if (line !== null) {
        expect(output).toContain(line);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. --step filter
// ---------------------------------------------------------------------------

describe('relay logs --verbose --step filter', () => {
  it('[LOGS-VRB-003] --step step-one includes events from that step file', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose', '--step', 'step-one'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    // The system.init event must be in the output.
    expect(output).toContain('sess1');
    // The stream.end event must be in the output.
    expect(output).toContain('end_turn');
  });

  it('[LOGS-VRB-004] --step nonexistent emits the no-event-log message', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose', '--step', 'nonexistent'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    expect(output).toContain('(no event log for this run)');
  });
});

// ---------------------------------------------------------------------------
// 3. Missing events directory
// ---------------------------------------------------------------------------

describe('relay logs --verbose — missing events directory', () => {
  it('[LOGS-VRB-005] run exists but events/ is absent emits the no-event-log message', async () => {
    // Create the run dir but NOT the events sub-directory.
    const runDir = join(tmpBase, '.relay', 'runs', 'abc123');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.json'), JSON.stringify({ flowName: 'test-flow' }));

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    expect(output).toContain('(no event log for this run)');
  });

  it('[LOGS-VRB-006] run exists, events/ exists but has no .jsonl files emits no-event-log message', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    // Write a non-jsonl file to verify the filter ignores it.
    await writeFile(join(eventsDir, 'notes.txt'), 'not a jsonl file');

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    expect(output).toContain('(no event log for this run)');
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown run id — process.exit(1) path
// ---------------------------------------------------------------------------

describe('relay logs — unknown run id', () => {
  it('[LOGS-VRB-007] unknown run id emits error message and calls process.exit(1)', async () => {
    process.argv = ['node', 'relay', 'logs', 'unknown-run', '--verbose'];

    await expect(logsCommand(['unknown-run'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');
    expect(output).toContain('unknown-run');
  });
});

// ---------------------------------------------------------------------------
// 5. Brand grammar smoke check
// ---------------------------------------------------------------------------

describe('relay logs --verbose — brand grammar compliance', () => {
  it('[LOGS-VRB-008] no emoji, no "simply", no trailing "!" in any stdout.write argument', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));

    for (const line of calls) {
      // No emoji — check the high-surrogate emoji planes (U+1F000..U+1FFFF)
      // which are unambiguously emoji. The lower Miscellaneous Symbols block
      // (U+2600..U+27BF) contains allowed brand symbols (✓ ✕ ⚠ ▶ ⊘) and must
      // not be included in this check.
      expect(line).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
      // "simply" is banned in user-facing copy
      expect(line.toLowerCase()).not.toContain('simply');
      // No trailing "!" on any line
      const trimmed = line.trimEnd();
      if (trimmed.length > 0) {
        expect(trimmed).not.toMatch(/!$/);
      }
    }
  });

  it('[LOGS-VRB-009] output contains the Relay mark in the header line', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);
    await writeFile(join(eventsDir, 'step-one.jsonl'), FIXTURE_NDJSON);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    // Header must contain the Relay mark.
    expect(output).toContain('●─▶●─▶●─▶●');
    // Header must reference the run id.
    expect(output).toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple .jsonl files — ordering
// ---------------------------------------------------------------------------

describe('relay logs --verbose — multiple step files', () => {
  it('[LOGS-VRB-010] two step files are rendered in alphabetical order', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);

    // step-a has seq 0 system.init; step-b has seq 0 turn.start.
    const stepA =
      JSON.stringify({
        seq: 0,
        ts: '2026-05-08T10:00:00.000Z',
        attempt: 1,
        event: {
          type: 'system.init',
          model: 'claude-opus-4-5',
          sessionId: 'sessA',
          tools: [],
          mcpServers: [],
        },
      }) + '\n';

    const stepB =
      JSON.stringify({
        seq: 0,
        ts: '2026-05-08T10:00:01.000Z',
        attempt: 1,
        event: { type: 'turn.start', turn: 1 },
      }) + '\n';

    await writeFile(join(eventsDir, 'step-a.jsonl'), stepA);
    await writeFile(join(eventsDir, 'step-b.jsonl'), stepB);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    // sessA appears in the step-a output; it must come before the turn.start line.
    const idxSessA = output.indexOf('sessA');
    const idxTurn = output.indexOf('turn 1');
    expect(idxSessA).toBeGreaterThanOrEqual(0);
    expect(idxTurn).toBeGreaterThanOrEqual(0);
    expect(idxSessA).toBeLessThan(idxTurn);
  });
});

// ---------------------------------------------------------------------------
// 7. Streaming-line behavior — text.delta events (FLAG-4)
// ---------------------------------------------------------------------------

describe('relay logs --verbose — streaming-line behavior', () => {
  it('[LOGS-VRB-011] interleaved text.delta events produce exactly one streaming line at the most-recent text.delta position', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);

    // Fixture: turn.start → text.delta(50) → tool.call → text.delta(75) → stream.end
    // Expected: one streaming line with charCount=125, positioned after tool.call
    // (streamingLineIndex tracks the most-recent text.delta cluster = lines.length
    // at the time of the second text.delta, which is after the tool.call line).
    const records = [
      {
        seq: 0,
        ts: '2026-05-08T10:00:00.000Z',
        attempt: 1,
        event: { type: 'turn.start', turn: 1 },
      },
      {
        seq: 1,
        ts: '2026-05-08T10:00:01.000Z',
        attempt: 1,
        event: { type: 'text.delta', delta: 'a'.repeat(50) },
      },
      {
        seq: 2,
        ts: '2026-05-08T10:00:02.000Z',
        attempt: 1,
        event: { type: 'tool.call', name: 'Bash', input: { cmd: 'ls' } },
      },
      {
        seq: 3,
        ts: '2026-05-08T10:00:03.000Z',
        attempt: 1,
        event: { type: 'text.delta', delta: 'b'.repeat(75) },
      },
      {
        seq: 4,
        ts: '2026-05-08T10:00:04.000Z',
        attempt: 1,
        event: { type: 'stream.end', stopReason: 'end_turn' },
      },
    ];
    const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(join(eventsDir, 'step-one.jsonl'), ndjson);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    const expectedStreamingLine = renderStreamingLine(125);

    // Exactly one streaming line in the output.
    const occurrences = output.split(expectedStreamingLine).length - 1;
    expect(occurrences).toBe(1);

    // The streaming line must appear after the tool.call line.
    const toolLine = '    · Bash({"cmd":"ls"})';
    const idxTool = output.indexOf(toolLine);
    const idxStreaming = output.indexOf(expectedStreamingLine);
    expect(idxTool).toBeGreaterThanOrEqual(0);
    expect(idxStreaming).toBeGreaterThanOrEqual(0);
    expect(idxStreaming).toBeGreaterThan(idxTool);
  });

  it('[LOGS-VRB-012] text.delta with no following non-text events still emits the streaming line at the most-recent text.delta cluster (before stream.end)', async () => {
    const { eventsDir } = await mkRunDir(tmpBase);

    // Fixture: turn.start → text.delta(30) → stream.end
    // Expected: one streaming line with charCount=30, at index 1 (= lines.length when text.delta arrived),
    // so it appears between turn.start and stream.end — not at the trailing end.
    const records = [
      {
        seq: 0,
        ts: '2026-05-08T10:00:00.000Z',
        attempt: 1,
        event: { type: 'turn.start', turn: 1 },
      },
      {
        seq: 1,
        ts: '2026-05-08T10:00:01.000Z',
        attempt: 1,
        event: { type: 'text.delta', delta: 'x'.repeat(30) },
      },
      {
        seq: 2,
        ts: '2026-05-08T10:00:02.000Z',
        attempt: 1,
        event: { type: 'stream.end', stopReason: 'end_turn' },
      },
    ];
    const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(join(eventsDir, 'step-one.jsonl'), ndjson);

    process.argv = ['node', 'relay', 'logs', 'abc123', '--verbose'];

    await logsCommand(['abc123'], {});

    const calls = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
    const output = calls.join('');

    const expectedStreamingLine = renderStreamingLine(30);

    // Exactly one streaming line in the output.
    const occurrences = output.split(expectedStreamingLine).length - 1;
    expect(occurrences).toBe(1);

    // The streaming line must appear before the stream.end done line.
    const doneLine = '    · done  end_turn';
    const idxDone = output.indexOf(doneLine);
    const idxStreaming = output.indexOf(expectedStreamingLine);
    expect(idxStreaming).toBeGreaterThanOrEqual(0);
    expect(idxDone).toBeGreaterThanOrEqual(0);
    expect(idxStreaming).toBeLessThan(idxDone);
  });
});
