/**
 * Per-run git worktree lifecycle helpers.
 *
 * Runs at the start of each run so two concurrent runs cannot corrupt each
 * other's working files — the subprocess (claude -p) is spawned with the
 * worktree path as its cwd, so every Read/Edit/Bash/Write it performs lands
 * in an isolated checkout. The worktree is removed in the Runner's finally
 * block.
 *
 * All three helpers return Result<T, PipelineError>. They never throw, and
 * they never inherit the parent process env — execFile is used with an
 * explicit arg array so a shell-injection vector through runId or a path is
 * impossible. spawn is deliberately avoided: these calls are one-shot,
 * short-lived, and have no streaming output to handle.
 */

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { err, ok, type Result } from 'neverthrow';

import { ERROR_CODES, PipelineError } from '../errors.js';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** Wall-clock cap on `git rev-parse --show-toplevel`. A stuck probe must not wedge the run. */
const GIT_REV_PARSE_TIMEOUT_MS = 5_000;

/** Wall-clock cap on `git worktree add`. Enough for a cold checkout; not so long that a stuck git stalls the run. */
const GIT_WORKTREE_ADD_TIMEOUT_MS = 30_000;

/** Wall-clock cap on `git worktree remove --force`. */
const GIT_WORKTREE_REMOVE_TIMEOUT_MS = 30_000;

/** Root directory under the OS temp dir where per-run worktrees live. */
const WORKTREES_SUBDIR = 'relay-worktrees';

function errorMessageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * Return the absolute path of the enclosing git working tree, or an error
 * when `dir` is not inside a git repo (or git is not on PATH).
 *
 * The caller decides whether an err means "fall back to running without a
 * worktree" (auto mode) or "abort the run" (required mode).
 *
 * The optional `signal` forwards the run's AbortSignal down to the git
 * subprocess so a SIGINT while the probe is in flight kills the child
 * immediately rather than letting it complete its ~80ms walk up the parent
 * directories.
 */
export async function isGitRepo(
  dir: string,
  signal?: AbortSignal,
): Promise<Result<string, PipelineError>> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeout: GIT_REV_PARSE_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    const gitRoot = stdout.trim();
    if (gitRoot.length === 0) {
      return err(
        new PipelineError(
          `git rev-parse --show-toplevel produced empty output in "${dir}"`,
          ERROR_CODES.RUNNER_FAILURE,
          { dir },
        ),
      );
    }
    return ok(gitRoot);
  } catch (caught) {
    return err(
      new PipelineError(
        `not a git repository at "${dir}": ${errorMessageOf(caught)}`,
        ERROR_CODES.RUNNER_FAILURE,
        { dir, cause: errorMessageOf(caught) },
      ),
    );
  }
}

export interface CreateWorktreeOptions {
  gitRoot: string;
  runId: string;
  logger: Logger;
  /**
   * Run-scoped AbortSignal. When provided and fired, the `git worktree add`
   * subprocess is killed immediately rather than running to completion,
   * keeping SIGINT-to-exit latency low.
   */
  signal?: AbortSignal;
}

/**
 * Create a fresh git worktree at `$TMPDIR/relay-worktrees/<runId>` pointing
 * at HEAD of `gitRoot`. On success the worktree path is returned; on failure
 * (git error, path collision, stuck subprocess) an err is returned with a
 * message the caller can surface verbatim.
 */
export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<Result<string, PipelineError>> {
  const worktreePath = join(tmpdir(), WORKTREES_SUBDIR, opts.runId);
  try {
    await execFileAsync('git', ['worktree', 'add', worktreePath, 'HEAD'], {
      cwd: opts.gitRoot,
      timeout: GIT_WORKTREE_ADD_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    opts.logger.debug(
      { event: 'worktree.create', worktreePath, gitRoot: opts.gitRoot, runId: opts.runId },
      'git worktree created',
    );
    return ok(worktreePath);
  } catch (caught) {
    const message = errorMessageOf(caught);
    opts.logger.warn(
      {
        event: 'worktree.create_failed',
        worktreePath,
        gitRoot: opts.gitRoot,
        runId: opts.runId,
        error: message,
      },
      'git worktree add failed',
    );
    return err(
      new PipelineError(
        `failed to create git worktree at "${worktreePath}": ${message}`,
        ERROR_CODES.RUNNER_FAILURE,
        { worktreePath, gitRoot: opts.gitRoot, runId: opts.runId, cause: message },
      ),
    );
  }
}

export interface RemoveWorktreeOptions {
  gitRoot: string;
  worktreePath: string;
  logger: Logger;
}

/**
 * Remove a previously-created worktree. Idempotent: if the path is already
 * gone (e.g. a prior cleanup succeeded, or the worktree was never created),
 * returns ok(undefined) without touching the filesystem or git metadata.
 *
 * Uses --force so an in-progress index/lockfile left by a crashed subprocess
 * does not block cleanup. The caller is the Runner's finally block; a stray
 * err here would mask the real failure that triggered the finally.
 */
export async function removeWorktree(
  opts: RemoveWorktreeOptions,
): Promise<Result<void, PipelineError>> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', opts.worktreePath], {
      cwd: opts.gitRoot,
      timeout: GIT_WORKTREE_REMOVE_TIMEOUT_MS,
    });
    opts.logger.debug(
      { event: 'worktree.remove', worktreePath: opts.worktreePath, gitRoot: opts.gitRoot },
      'git worktree removed',
    );
    return ok(undefined);
  } catch (caught) {
    const message = errorMessageOf(caught);
    // `git worktree remove` errors loudly when the path does not exist. Treat
    // that as a successful no-op — the caller's intent is "ensure it is gone",
    // and it already is. Detection is substring-based because git's exact
    // wording is not part of its stable CLI contract across versions.
    if (isMissingWorktreeError(message)) {
      opts.logger.debug(
        {
          event: 'worktree.remove_noop',
          worktreePath: opts.worktreePath,
          gitRoot: opts.gitRoot,
        },
        'git worktree already absent',
      );
      return ok(undefined);
    }
    opts.logger.warn(
      {
        event: 'worktree.remove_failed',
        worktreePath: opts.worktreePath,
        gitRoot: opts.gitRoot,
        error: message,
      },
      'git worktree remove failed',
    );
    return err(
      new PipelineError(
        `failed to remove git worktree at "${opts.worktreePath}": ${message}`,
        ERROR_CODES.RUNNER_FAILURE,
        { worktreePath: opts.worktreePath, gitRoot: opts.gitRoot, cause: message },
      ),
    );
  }
}

function isMissingWorktreeError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('is not a working tree') ||
    lower.includes('not a valid path') ||
    lower.includes("doesn't exist") ||
    lower.includes('does not exist') ||
    lower.includes('no such file or directory')
  );
}
