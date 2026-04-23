import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports — register the spawn mock first so the
// process module under test picks up the mock when it imports node:child_process.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args),
  };
});

import type { Logger } from '../../../src/logger.js';
import { runClaudeProcess } from '../../../src/providers/claude-cli/process.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface MockChildHandles {
  child: EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc: string) => void };
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
}

function makeChild(): MockChildHandles {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk: string, _enc: string, cb?: (err?: Error | null) => void) => {
      if (typeof cb === 'function') cb(null);
      return true;
    }),
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn().mockReturnValue(true),
  });
  return { child };
}

function makeLogger(): Logger {
  const noop = vi.fn();
  // Minimal pino-shaped logger used inside the step. Only debug() is invoked
  // from the production code path; the others are present so a future code
  // change cannot silently start swallowing logs.
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    level: 'silent',
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

async function collect(
  gen: AsyncGenerator<unknown, unknown, void>,
): Promise<{ values: unknown[]; result: unknown }> {
  const values: unknown[] = [];
  let next = await gen.next();
  while (!next.done) {
    values.push(next.value);
    next = await gen.next();
  }
  return { values, result: next.value };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runClaudeProcess', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[CLI-PROC-001] happy path — yields one parsed JSON object per NDJSON line', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: ['-p'],
      env: { PATH: '/usr/bin' },
      prompt: 'hello',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });

    const collector = collect(gen);

    // Real stdout shape from `claude -p`: a system.init envelope, an assistant
    // text envelope, and a final result envelope, each newline-delimited.
    child.stdout.emit(
      'data',
      '{"type":"system","subtype":"init","session_id":"s1"}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    );
    child.stdout.emit(
      'data',
      '{"type":"result","subtype":"success","stop_reason":"end_turn","session_id":"s1"}\n',
    );
    child.emit('close', 0, null);

    const { values, result } = await collector;
    expect(values).toEqual([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', session_id: 's1' },
    ]);
    expect(result).toEqual({ exitCode: 0, stderr: '', signal: null });
  });

  it('[CLI-PROC-002] joins partial chunks across newlines (split mid-line)', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: 'p',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    child.stdout.emit('data', '{"type":"sys');
    child.stdout.emit('data', 'tem","subtype":"init"}\n{"type":"assist');
    child.stdout.emit('data', 'ant","message":{"content":[]}}\n');
    // A trailing line WITHOUT a newline must still be flushed by the close handler.
    child.stdout.emit('data', '{"type":"result","subtype":"success"}');
    child.emit('close', 0, null);

    const { values, result } = await collector;
    expect(values).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(result).toEqual({ exitCode: 0, stderr: '', signal: null });
  });

  it('[CLI-PROC-003] writes prompt to stdin then ends it', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: ['-p'],
      env: {},
      prompt: 'the prompt body',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    // Allow a microtask so the step attaches its handlers and writes stdin.
    await Promise.resolve();
    expect(child.stdin.write).toHaveBeenCalledWith('the prompt body', 'utf8', expect.any(Function));
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    child.emit('close', 0, null);
    await collector;
  });

  it('[CLI-PROC-004] malformed lines are debug-logged and skipped (never throw)', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const logger = makeLogger();
    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger,
    });
    const collector = collect(gen);

    child.stdout.emit(
      'data',
      '{"type":"system"}\n' + 'this is not json at all\n' + '{"oops":\n' + '{"type":"result"}\n',
    );
    child.emit('close', 0, null);

    const { values, result } = await collector;
    expect(values).toEqual([{ type: 'system' }, { type: 'result' }]);
    expect(result).toEqual({ exitCode: 0, stderr: '', signal: null });
    // At least one debug call per malformed line. The step emits a debug log
    // per skipped line; assert the event name is present.
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const malformedCalls = debugCalls.filter((c) => {
      const meta = c[0];
      return (
        typeof meta === 'object' &&
        meta !== null &&
        'event' in meta &&
        meta.event === 'claude-cli.ndjson.malformed'
      );
    });
    expect(malformedCalls.length).toBe(2);
  });

  it('[CLI-PROC-005] stderr is capped at 8 KiB, keeping the newest bytes', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    // Two writes whose combined size exceeds 8 KiB. The newest 8 KiB should win:
    // 6 KiB 'A' + 7 KiB 'B' = 13 KiB; capped result is the trailing 8 KiB
    // — that is, 1 KiB of 'A' followed by 7 KiB of 'B'.
    const oldChunk = Buffer.alloc(6 * 1024, 0x41); // 6 KiB of 'A'
    const newChunk = Buffer.alloc(7 * 1024, 0x42); // 7 KiB of 'B'
    child.stderr.emit('data', oldChunk);
    child.stderr.emit('data', newChunk);
    child.emit('close', 1, null);

    const { result } = await collector;
    expect(result).toMatchObject({ exitCode: 1, signal: null });
    const captured = (result as { stderr: string }).stderr;
    expect(captured.length).toBe(8 * 1024);
    // Trailing 7 KiB are 'B'; leading 1 KiB are the most-recent 'A' bytes.
    expect(captured.endsWith('B')).toBe(true);
    expect(captured.endsWith('B'.repeat(7 * 1024))).toBe(true);
    expect(captured.startsWith('A'.repeat(1024))).toBe(true);
    // The dropped portion of 'A' (5 KiB) is gone — only the trailing 1 KiB remains.
    expect(captured.split('A').length - 1).toBe(1024);
  });

  it('[CLI-PROC-005b] stderr cap when a single oversize chunk arrives — newest 8 KiB only', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    // 12 KiB single chunk: first 4 KiB 'A', last 8 KiB 'B'. Cap keeps 'B'.
    const oversize = Buffer.concat([Buffer.alloc(4 * 1024, 0x41), Buffer.alloc(8 * 1024, 0x42)]);
    child.stderr.emit('data', oversize);
    child.emit('close', 1, null);

    const { result } = await collector;
    const captured = (result as { stderr: string }).stderr;
    expect(captured.length).toBe(8 * 1024);
    expect(captured).toBe('B'.repeat(8 * 1024));
  });

  it('[CLI-PROC-006] abort sends SIGTERM, then SIGKILL after 2s grace (fake timers)', async () => {
    vi.useFakeTimers();
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const controller = new AbortController();
    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: controller.signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    // Allow the step to attach its abort listener.
    await Promise.resolve();

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);

    // Before the grace window, no escalation.
    vi.advanceTimersByTime(1999);
    expect(child.kill).toHaveBeenCalledTimes(1);

    // Crossing the 2000 ms threshold escalates to SIGKILL.
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.kill).toHaveBeenCalledTimes(2);

    // The child finally exits — generator returns the signal from the close.
    child.emit('close', null, 'SIGKILL');
    const { result } = await collector;
    expect(result).toEqual({ exitCode: null, stderr: '', signal: 'SIGKILL' });
  });

  it('[CLI-PROC-007] aborting after the child has already exited is a no-op', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const controller = new AbortController();
    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: controller.signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    child.emit('close', 0, null);
    await collector;

    // Late abort must not throw or call kill again past the natural exit.
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('[CLI-PROC-008] ENOENT spawn error → exitCode null + message in stderr (no throw)', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/no/such/binary',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    // Node emits 'error' for ENOENT/EACCES, then 'close' with code null.
    const enoent = Object.assign(new Error('spawn /no/such/binary ENOENT'), {
      code: 'ENOENT',
    });
    child.emit('error', enoent);
    child.emit('close', null, null);

    const { values, result } = await collector;
    expect(values).toEqual([]);
    expect(result).toEqual({
      exitCode: null,
      stderr: 'spawn /no/such/binary ENOENT',
      signal: null,
    });
  });

  it('[CLI-PROC-009] EACCES spawn error captured the same way', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/etc/passwd',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    const eacces = Object.assign(new Error('spawn /etc/passwd EACCES'), {
      code: 'EACCES',
    });
    child.emit('error', eacces);
    child.emit('close', null, null);

    const { result } = await collector;
    expect(result).toEqual({
      exitCode: null,
      stderr: 'spawn /etc/passwd EACCES',
      signal: null,
    });
  });

  it('[CLI-PROC-010] synchronous spawn throw is caught and surfaced', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('synchronous spawn failure');
    });

    const gen = runClaudeProcess({
      binary: 'broken',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });

    const { values, result } = await collect(gen);
    expect(values).toEqual([]);
    expect(result).toEqual({
      exitCode: null,
      stderr: 'synchronous spawn failure',
      signal: null,
    });
  });

  it('[CLI-PROC-012] forwards cwd to spawn when provided', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: ['-p'],
      env: { PATH: '/usr/bin' },
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
      cwd: '/tmp/worktree',
    });
    const collector = collect(gen);

    child.emit('close', 0, null);
    await collector;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binaryArg, argsArg, optionsArg] = spawnMock.mock.calls[0];
    expect(binaryArg).toBe('/usr/bin/claude');
    expect(argsArg).toEqual(['-p']);
    expect(optionsArg).toMatchObject({
      env: { PATH: '/usr/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp/worktree',
    });
  });

  it('[CLI-PROC-013] omits cwd from spawn options when undefined', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: ['-p'],
      env: { PATH: '/usr/bin' },
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    child.emit('close', 0, null);
    await collector;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , optionsArg] = spawnMock.mock.calls[0];
    expect(optionsArg).toEqual({
      env: { PATH: '/usr/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(optionsArg).not.toHaveProperty('cwd');
  });

  it('[CLI-PROC-011] CRLF line endings are tolerated', async () => {
    const { child } = makeChild();
    spawnMock.mockReturnValue(child);

    const gen = runClaudeProcess({
      binary: '/usr/bin/claude',
      cliArgs: [],
      env: {},
      prompt: '',
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
    });
    const collector = collect(gen);

    child.stdout.emit('data', '{"a":1}\r\n{"b":2}\r\n');
    child.emit('close', 0, null);

    const { values } = await collector;
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
