/**
 * Subprocess step for the `claude -p` binary.
 *
 * Spawns the CLI with piped stdio, writes the prompt to stdin, then reads
 * NDJSON output line by line. Each newline-terminated line is parsed as JSON
 * and yielded from the async generator. Malformed lines are debug-logged and
 * skipped — they never crash the stream.
 *
 * Stderr is accumulated with a hard 8 KiB cap (newest bytes win on overflow)
 * and returned as part of the generator's terminal value alongside the exit
 * code and signal.
 *
 * Abort handling: on AbortSignal abort the step sends SIGTERM, waits 2s,
 * then escalates to SIGKILL. Spawn failures (ENOENT, EACCES) surface as the
 * terminal value `{ exitCode: null, stderr: <error message>, signal: null }`
 * — the generator never throws.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import type { Logger } from '../../logger.js';

const STDERR_CAP_BYTES = 8 * 1024;
const SIGKILL_GRACE_MS = 2000;

export interface RunClaudeProcessArgs {
  binary: string;
  cliArgs: string[];
  env: Record<string, string | undefined>;
  prompt: string;
  abortSignal: AbortSignal;
  logger: Logger;
  /**
   * Working directory for the spawned subprocess. When undefined the child
   * inherits the parent process cwd (spawn's default).
   */
  cwd?: string;
}

export interface RunClaudeProcessResult {
  exitCode: number | null;
  stderr: string;
  signal: NodeJS.Signals | null;
}

interface QueueItem {
  kind: 'value' | 'end';
  value?: unknown;
  result?: RunClaudeProcessResult;
}

/**
 * Bounded ring of UTF-8 bytes that always retains the most recent
 * STDERR_CAP_BYTES bytes appended. Older bytes are dropped on overflow.
 */
class StderrRing {
  #buf: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.#buf.length === 0) {
      this.#buf =
        chunk.length <= STDERR_CAP_BYTES
          ? Buffer.from(chunk)
          : Buffer.from(chunk.subarray(chunk.length - STDERR_CAP_BYTES));
      return;
    }
    if (chunk.length >= STDERR_CAP_BYTES) {
      this.#buf = Buffer.from(chunk.subarray(chunk.length - STDERR_CAP_BYTES));
      return;
    }
    const combined = Buffer.concat([this.#buf, chunk]);
    if (combined.length <= STDERR_CAP_BYTES) {
      this.#buf = combined;
    } else {
      this.#buf = combined.subarray(combined.length - STDERR_CAP_BYTES);
    }
  }

  toString(): string {
    return this.#buf.toString('utf8');
  }
}

/**
 * Spawn `claude -p` and stream parsed NDJSON envelopes.
 *
 * The async generator yields each parsed JSON object as it arrives, then
 * returns a result envelope describing how the child exited. Malformed lines
 * are skipped (debug-logged), and any failure to spawn the binary surfaces
 * as the terminal return value rather than a thrown error.
 */
export async function* runClaudeProcess(
  args: RunClaudeProcessArgs,
): AsyncGenerator<unknown, RunClaudeProcessResult, void> {
  const { binary, cliArgs, env, prompt, abortSignal, logger, cwd } = args;

  let child: ChildProcess;
  try {
    child = spawn(binary, cliArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.debug(
      { event: 'claude-cli.spawn.failed', binary, message },
      'spawn threw synchronously',
    );
    return { exitCode: null, stderr: message, signal: null };
  }

  const queue: QueueItem[] = [];
  let waiter: ((item: QueueItem) => void) | null = null;
  let stdoutBuffer = '';
  const stderr = new StderrRing();
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  const push = (item: QueueItem): void => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(item);
      return;
    }
    queue.push(item);
  };

  const next = (): Promise<QueueItem> => {
    const head = queue.shift();
    if (head !== undefined) return Promise.resolve(head);
    return new Promise<QueueItem>((resolve) => {
      waiter = resolve;
    });
  };

  const flushLine = (line: string): void => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.debug(
        { event: 'claude-cli.ndjson.malformed', message, sample: line.slice(0, 200) },
        'skipping malformed NDJSON line',
      );
      return;
    }
    push({ kind: 'value', value: parsed });
  };

  const stdout = child.stdout;
  if (stdout !== null) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        flushLine(trimmed);
        newlineIdx = stdoutBuffer.indexOf('\n');
      }
    });
  }

  const stderrStream = child.stderr;
  if (stderrStream !== null) {
    stderrStream.on('data', (chunk: Buffer) => {
      stderr.append(chunk);
    });
  }

  // Treat stdin write/close failures as best-effort. The child may have already
  // exited (e.g. ENOENT-after-spawn races); the close() call fires immediately
  // either way. The 'error' handler below converts the spawn failure into the
  // terminal return value.
  const stdin = child.stdin;
  if (stdin !== null) {
    stdin.on('error', (cause: Error) => {
      logger.debug(
        { event: 'claude-cli.stdin.error', message: cause.message },
        'stdin write/end failed',
      );
    });
    stdin.write(prompt, 'utf8', () => {
      stdin.end();
    });
  }

  const cleanup = (): void => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (onAbort !== null) {
      abortSignal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
  };

  const triggerAbort = (): void => {
    // SIGTERM first; if the child does not exit within the grace window,
    // escalate to SIGKILL. Both kills are best-effort — the child may already
    // be gone, in which case Node returns false and we proceed regardless.
    child.kill('SIGTERM');
    if (killTimer === null) {
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
      // The escalation timer itself must not keep the event loop alive after
      // the child exits — close handler clears it via cleanup().
      if (typeof killTimer.unref === 'function') {
        killTimer.unref();
      }
    }
  };

  if (abortSignal.aborted) {
    triggerAbort();
  } else {
    onAbort = (): void => {
      triggerAbort();
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  child.on('error', (cause: Error) => {
    // Spawn-time errors (ENOENT, EACCES) and post-spawn process errors both
    // arrive here. We capture the message, do NOT throw, and let the close
    // handler (which still fires for spawn errors with code null) terminate
    // the stream. If close has already fired we end here ourselves.
    const message = cause.message;
    stderr.append(Buffer.from(message, 'utf8'));
    logger.debug({ event: 'claude-cli.process.error', message }, 'child process emitted error');
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    // Drain the stdout tail. Node guarantees 'data' events flush before
    // 'close', so anything left in stdoutBuffer is a final line missing its
    // trailing newline.
    if (stdoutBuffer.length > 0) {
      const trimmed = stdoutBuffer.endsWith('\r') ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
      stdoutBuffer = '';
      flushLine(trimmed);
    }
    cleanup();
    push({
      kind: 'end',
      result: { exitCode: code, stderr: stderr.toString(), signal },
    });
  });

  try {
    while (true) {
      const item = await next();
      if (item.kind === 'end') {
        // result is always populated for 'end' items by the close handler.
        return item.result ?? { exitCode: null, stderr: stderr.toString(), signal: null };
      }
      yield item.value;
    }
  } finally {
    cleanup();
  }
}
