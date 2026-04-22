import { spawn } from 'node:child_process';
import type { Logger } from '../../logger.js';
import { TimeoutError } from '../../errors.js';

const STDOUT_LIMIT = 10 * 1024 * 1024; // 10 MB per stream
const STDERR_LIMIT = 10 * 1024 * 1024;
const SIGKILL_GRACE_MS = 2000;

export interface RunProcessOptions {
  cmd: string;
  args: string[];
  cwd: string;
  /** user-controlled shell; claude env allowlist does not apply. */
  env: Record<string, string>;
  timeoutMs: number | undefined;
  abortSignal: AbortSignal;
  captureStdout: boolean;
  captureStderr: boolean;
  logger: Logger;
  runnerId: string;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: string | undefined;
  stderr: string | undefined;
}

/**
 * Spawns a subprocess with piped stdio, an optional timeout, and abort-signal
 * wiring. Returns exit code plus optionally-captured stdout/stderr.
 *
 * Never uses shell: true — avoids shell injection and keeps argument
 * handling deterministic. Callers that need shell interpolation must
 * pre-expand args before calling runProcess.
 */
export async function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const {
    cmd,
    args,
    cwd,
    env,
    timeoutMs,
    abortSignal,
    captureStdout,
    captureStderr,
    logger,
    runnerId,
  } = opts;

  const internalAbort = new AbortController();

  const onExternalAbort = (): void => {
    internalAbort.abort();
  };
  abortSignal.addEventListener('abort', onExternalAbort, { once: true });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      internalAbort.abort();
    }, timeoutMs);
  }

  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: 'pipe',
    shell: false,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  if (captureStdout && child.stdout !== null) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= STDOUT_LIMIT) {
        if (stdoutBytes === STDOUT_LIMIT) {
          logger.warn(
            { event: 'stdout.truncated', runnerId, limitBytes: STDOUT_LIMIT },
            'stdout exceeded buffer limit and was truncated',
          );
          stdoutBytes += 1; // ensure the warn fires only once
        }
        return;
      }
      const remaining = STDOUT_LIMIT - stdoutBytes;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
    });
  } else if (child.stdout !== null) {
    child.stdout.resume();
  }

  if (captureStderr && child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT) {
        if (stderrBytes === STDERR_LIMIT) {
          logger.warn(
            { event: 'stderr.truncated', runnerId, limitBytes: STDERR_LIMIT },
            'stderr exceeded buffer limit and was truncated',
          );
          stderrBytes += 1; // ensure the warn fires only once
        }
        return;
      }
      const remaining = STDERR_LIMIT - stderrBytes;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });
  } else if (child.stderr !== null) {
    child.stderr.resume();
  }

  const killChild = (): void => {
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
    }, SIGKILL_GRACE_MS);
  };

  internalAbort.signal.addEventListener('abort', killChild, { once: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  }).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    abortSignal.removeEventListener('abort', onExternalAbort);
    internalAbort.signal.removeEventListener('abort', killChild);
  });

  if (timedOut) {
    throw new TimeoutError(
      `runner "${runnerId}" exceeded timeout of ${timeoutMs ?? 0}ms`,
      runnerId,
      timeoutMs ?? 0,
    );
  }

  const stdout = captureStdout ? Buffer.concat(stdoutChunks).toString('utf8') : undefined;
  const stderr = captureStderr ? Buffer.concat(stderrChunks).toString('utf8') : undefined;

  return { exitCode, stdout, stderr };
}
