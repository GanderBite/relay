import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock. execFile is promisified at module init inside worktree.ts,
// so the mock must be registered before worktree.ts loads. The real
// node:child_process.execFile carries a util.promisify.custom symbol that
// produces { stdout, stderr } on resolve; the mock replicates the same
// contract so await execFileAsync(...) returns the same shape in tests.
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const impl = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => mockExecFile(cmd, args, opts, cb);
  const customPromisified = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(cmd, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err !== null) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  Object.defineProperty(impl, promisify.custom, { value: customPromisified });
  return {
    ...actual,
    execFile: impl,
  };
});

import { PipelineError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import { createWorktree, isGitRepo, removeWorktree } from '../../src/util/worktree.js';

interface LoggerStub {
  logger: Logger;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function makeLogger(): LoggerStub {
  const debug = vi.fn();
  const warn = vi.fn();
  const noop = vi.fn();
  const logger = {
    debug,
    warn,
    info: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    child: vi.fn(() => logger),
  } as unknown as Logger;
  return { logger, debug, warn };
}

function stubExecOk(stdout = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (e: Error | null, so: string, se: string) => void,
    ) => {
      cb(null, stdout, '');
    },
  );
}

function stubExecError(err: Error): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (e: Error | null, so: string, se: string) => void,
    ) => {
      cb(err, '', '');
    },
  );
}

describe('isGitRepo', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('returns ok(gitRoot) when git rev-parse succeeds', async () => {
    stubExecOk('/Users/me/my-repo\n');

    const result = await isGitRepo('/Users/me/my-repo/races/foo');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/Users/me/my-repo');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
      string,
      readonly string[],
      { cwd?: string; timeout?: number },
    ];
    expect(cmd).toBe('git');
    expect(args).toEqual(['rev-parse', '--show-toplevel']);
    expect(opts.cwd).toBe('/Users/me/my-repo/races/foo');
    expect(opts.timeout).toBe(5_000);
  });

  it('returns err when directory is not a git repo', async () => {
    const gitErr = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
    stubExecError(gitErr);

    const result = await isGitRepo('/tmp/not-a-repo');

    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(PipelineError);
    expect(e.message).toContain('not a git repository at "/tmp/not-a-repo"');
    expect(e.message).toContain('fatal: not a git repository');
  });

  it('returns err when git binary is not installed', async () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    stubExecError(enoent);

    const result = await isGitRepo('/any/dir');

    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(PipelineError);
    expect(e.message).toContain('spawn git ENOENT');
  });

  it('returns err when rev-parse output is empty', async () => {
    stubExecOk('   \n');

    const result = await isGitRepo('/edge/case');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty output');
  });
});

describe('createWorktree', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('returns ok(worktreePath) on a clean git worktree add', async () => {
    stubExecOk('');
    const { logger, debug } = makeLogger();

    const result = await createWorktree({
      gitRoot: '/Users/me/my-repo',
      runId: 'abc123',
      logger,
    });

    expect(result.isOk()).toBe(true);
    const expectedPath = join(tmpdir(), 'relay-worktrees', 'abc123');
    expect(result._unsafeUnwrap()).toBe(expectedPath);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
      string,
      readonly string[],
      { cwd?: string; timeout?: number },
    ];
    expect(cmd).toBe('git');
    expect(args).toEqual(['worktree', 'add', expectedPath, 'HEAD']);
    expect(opts.cwd).toBe('/Users/me/my-repo');
    expect(typeof opts.timeout).toBe('number');

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worktree.create', worktreePath: expectedPath }),
      expect.any(String),
    );
  });

  it('returns err when git worktree add fails (path collision)', async () => {
    const gitErr = new Error("fatal: '/tmp/relay-worktrees/dup' already exists");
    stubExecError(gitErr);
    const { logger, warn } = makeLogger();

    const result = await createWorktree({
      gitRoot: '/Users/me/my-repo',
      runId: 'dup',
      logger,
    });

    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(PipelineError);
    expect(e.message).toContain('failed to create git worktree');
    expect(e.message).toContain('already exists');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worktree.create_failed' }),
      expect.any(String),
    );
  });

  it('attempts best-effort cleanup via git worktree remove after a failed add', async () => {
    // First call (worktree add) fails; second call (worktree remove --force)
    // is the best-effort cleanup the Orchestrator relies on so a partial checkout
    // cannot leak under $TMPDIR/relay-worktrees across thousands of runs.
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (e: Error | null, so: string, se: string) => void,
      ) => {
        cb(new Error('fatal: something went wrong mid-add'), '', '');
      },
    );
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (e: Error | null, so: string, se: string) => void,
      ) => {
        cb(null, '', '');
      },
    );
    const { logger } = makeLogger();
    const expectedPath = join(tmpdir(), 'relay-worktrees', 'cleanup');

    const result = await createWorktree({
      gitRoot: '/Users/me/my-repo',
      runId: 'cleanup',
      logger,
    });

    expect(result.isErr()).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const [addCmd, addArgs] = mockExecFile.mock.calls[0] as [string, readonly string[]];
    const [rmCmd, rmArgs] = mockExecFile.mock.calls[1] as [string, readonly string[]];
    expect(addCmd).toBe('git');
    expect(addArgs).toEqual(['worktree', 'add', expectedPath, 'HEAD']);
    expect(rmCmd).toBe('git');
    expect(rmArgs).toEqual(['worktree', 'remove', '--force', expectedPath]);
  });

  it('preserves the original error when the best-effort cleanup also fails', async () => {
    // Both calls fail. The original "unable to create" error must reach the
    // caller; the secondary cleanup failure must not replace it.
    const addErr = new Error('fatal: unable to create worktree');
    const rmErr = new Error('fatal: unable to remove worktree');
    mockExecFile
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: readonly string[],
          _opts: unknown,
          cb: (e: Error | null, so: string, se: string) => void,
        ) => {
          cb(addErr, '', '');
        },
      )
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: readonly string[],
          _opts: unknown,
          cb: (e: Error | null, so: string, se: string) => void,
        ) => {
          cb(rmErr, '', '');
        },
      );
    const { logger } = makeLogger();

    const result = await createWorktree({
      gitRoot: '/Users/me/my-repo',
      runId: 'both-fail',
      logger,
    });

    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.message).toContain('failed to create git worktree');
    expect(e.message).toContain('unable to create worktree');
    expect(e.message).not.toContain('unable to remove worktree');
  });
});

describe('removeWorktree', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('returns ok on a clean git worktree remove --force', async () => {
    stubExecOk('');
    const { logger, debug } = makeLogger();
    const worktreePath = join(tmpdir(), 'relay-worktrees', 'xyz789');

    const result = await removeWorktree({
      gitRoot: '/Users/me/my-repo',
      worktreePath,
      logger,
    });

    expect(result.isOk()).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
      string,
      readonly string[],
      { cwd?: string },
    ];
    expect(cmd).toBe('git');
    expect(args).toEqual(['worktree', 'remove', '--force', worktreePath]);
    expect(opts.cwd).toBe('/Users/me/my-repo');
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worktree.remove', worktreePath }),
      expect.any(String),
    );
  });

  it('returns ok when the worktree path is already gone (idempotent)', async () => {
    const gitErr = new Error("fatal: '/tmp/relay-worktrees/gone' is not a working tree");
    stubExecError(gitErr);
    const { logger, debug, warn } = makeLogger();

    const result = await removeWorktree({
      gitRoot: '/Users/me/my-repo',
      worktreePath: '/tmp/relay-worktrees/gone',
      logger,
    });

    expect(result.isOk()).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worktree.remove_noop' }),
      expect.any(String),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns ok when git reports "does not exist" (idempotent)', async () => {
    const gitErr = new Error("fatal: '/tmp/relay-worktrees/missing' does not exist");
    stubExecError(gitErr);
    const { logger } = makeLogger();

    const result = await removeWorktree({
      gitRoot: '/Users/me/my-repo',
      worktreePath: '/tmp/relay-worktrees/missing',
      logger,
    });

    expect(result.isOk()).toBe(true);
  });

  it('returns err on an unexpected git failure', async () => {
    const gitErr = new Error('fatal: unable to read index');
    stubExecError(gitErr);
    const { logger, warn } = makeLogger();

    const result = await removeWorktree({
      gitRoot: '/Users/me/my-repo',
      worktreePath: '/tmp/relay-worktrees/abc',
      logger,
    });

    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(PipelineError);
    expect(e.message).toContain('failed to remove git worktree');
    expect(e.message).toContain('unable to read index');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worktree.remove_failed' }),
      expect.any(String),
    );
  });
});
