import { access } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { Logger } from '../logger.js';
import { createWorktree, isGitRepo, probeWorktree, removeWorktree } from '../util/worktree.js';

export interface WorktreeSetupResult {
  worktreePath: string | undefined;
  gitRoot: string | undefined;
  worktreeCwd: string | undefined;
}

/**
 * Bring up a per-run git worktree so the provider subprocess operates on an
 * isolated checkout. The return value carries the worktree path, the
 * enclosing git root, and the worktree-equivalent of `flowDir` — the
 * subprocess cwd the walker passes to each executor. When isolation is
 * disabled or silently skipped (auto mode outside a git repo), all three
 * fields are undefined and the subprocess inherits the parent cwd.
 *
 * `worktree: true` is an explicit opt-in to isolation; any probe or create
 * failure is surfaced so the run aborts before any tokens are spent.
 * `worktree: 'auto'` (the default) treats the feature as best-effort and
 * logs a debug breadcrumb when the repo is unavailable.
 */
export async function setupWorktree(args: {
  flowDir: string;
  runId: string;
  setting: boolean | 'auto' | undefined;
  logger: Logger;
  signal: AbortSignal;
}): Promise<WorktreeSetupResult> {
  const setting = args.setting ?? 'auto';
  if (setting === false) {
    return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
  }
  const required = setting === true;

  // Short-circuit when abort has already fired so we neither spawn git nor
  // pay the rev-parse probe's wall clock. The caller's post-setup check
  // notices the aborted signal and skips the DAG walker.
  if (args.signal.aborted) {
    return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
  }

  const probeDir = isAbsolute(args.flowDir) ? args.flowDir : join(process.cwd(), args.flowDir);
  const gitResult = await isGitRepo(probeDir, args.signal);
  if (gitResult.isErr()) {
    if (required) throw gitResult.error;
    args.logger.debug(
      { event: 'worktree.skip_no_repo', flowDir: probeDir },
      'not a git repo; proceeding without worktree isolation',
    );
    return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
  }

  const gitRoot = gitResult.value;

  // Abort may have fired while the probe was in flight. Skip the create to
  // avoid a stray worktree the caller would immediately have to tear down.
  if (args.signal.aborted) {
    return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
  }

  const candidateExisting = probeWorktree(args.runId);
  try {
    await access(candidateExisting);
    // Worktree already present — this is a resume; adopt it without re-creating.
    args.logger.debug(
      { event: 'worktree.adopt', worktreePath: candidateExisting, runId: args.runId },
      'adopting existing worktree for resumed run',
    );
    const rel = relative(gitRoot, probeDir);
    const candidate =
      rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        ? join(candidateExisting, rel)
        : candidateExisting;
    let worktreeCwd: string;
    try {
      await access(candidate);
      worktreeCwd = candidate;
    } catch {
      worktreeCwd = candidateExisting;
    }
    return { worktreePath: candidateExisting, gitRoot, worktreeCwd };
  } catch {
    // Worktree does not exist yet — fall through to createWorktree.
  }

  const createResult = await createWorktree({
    gitRoot,
    runId: args.runId,
    logger: args.logger,
    signal: args.signal,
  });
  if (createResult.isErr()) {
    if (required) throw createResult.error;
    args.logger.debug(
      { event: 'worktree.skip_create_failed', gitRoot, error: createResult.error.message },
      'worktree creation failed; proceeding without isolation',
    );
    return { worktreePath: undefined, gitRoot: undefined, worktreeCwd: undefined };
  }

  const worktreePath = createResult.value;

  // Map the original flowDir onto its equivalent path inside the worktree so
  // the subprocess runs at the same relative location it would in the real
  // checkout. When flowDir is outside gitRoot (e.g. a flow installed in
  // node_modules that sits alongside the repo rather than inside it) the
  // relative path starts with '..'; joining that onto worktreePath would
  // escape the isolated checkout entirely, so we fall back to the worktree
  // root. The flow package is still read from its original flowDir — only
  // the subprocess cwd is rebased.
  const rel = relative(gitRoot, probeDir);
  const candidate =
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      ? join(worktreePath, rel)
      : worktreePath;

  // Untracked flow directories won't exist inside the worktree — fall back to
  // the worktree root so the subprocess cwd is always a real path.
  let worktreeCwd: string;
  try {
    await access(candidate);
    worktreeCwd = candidate;
  } catch {
    worktreeCwd = worktreePath;
  }

  return { worktreePath, gitRoot, worktreeCwd };
}

/**
 * Remove the per-run worktree. Called from the run's finally block, so any
 * failure is logged at warn and swallowed — letting a cleanup error escape
 * would mask the real failure that triggered the finally. Cleanup is bounded
 * by the 30 s GIT_WORKTREE_REMOVE_TIMEOUT_MS inside worktree.ts; on timeout
 * the error is logged at warn and the run completes normally.
 */
export async function teardownWorktree(
  worktreePath: string | undefined,
  gitRoot: string | undefined,
  logger: Logger,
): Promise<void> {
  if (worktreePath === undefined || gitRoot === undefined) return;
  const result = await removeWorktree({ gitRoot, worktreePath, logger });
  if (result.isErr()) {
    logger.warn(
      {
        event: 'worktree.cleanup_failed',
        worktreePath,
        gitRoot,
        error: result.error.message,
      },
      'worktree cleanup failed',
    );
  }
}
