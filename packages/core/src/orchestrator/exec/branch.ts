import type { Logger } from '../../logger.js';
import { RunnerFailureError } from '../../errors.js';
import type { BranchRunnerSpec } from '../../race/types.js';
import { runProcess } from './process.js';
import { splitShell } from './shlex.js';

export interface BranchExecContext {
  runDir: string;
  runnerId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface BranchRunnerResult {
  exitCode: number;
  next?: string;
}

export async function executeBranch(
  runner: BranchRunnerSpec,
  ctx: BranchExecContext,
): Promise<BranchRunnerResult> {
  const { runDir, runnerId, attempt, abortSignal, logger } = ctx;

  const rawArgs = Array.isArray(runner.run) ? runner.run : splitShell(runner.run);
  const [cmd, ...args] = rawArgs;
  if (cmd === undefined) {
    throw new RunnerFailureError(
      `runner "${runnerId}" has an empty run command`,
      runnerId,
      attempt,
    );
  }

  const cwd = runner.cwd ?? runDir;

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const env: Record<string, string> = { ...baseEnv, ...(runner.env ?? {}) };

  const result = await runProcess({
    cmd,
    args,
    cwd,
    env,
    timeoutMs: runner.timeoutMs,
    abortSignal,
    captureStdout: false,
    captureStderr: false,
    logger,
    runnerId,
  });

  const exitCodeKey = String(result.exitCode);
  const mapped = runner.onExit[exitCodeKey];

  if (mapped !== undefined) {
    const next = mapped === 'abort' || mapped === 'continue' ? undefined : mapped;
    return { exitCode: result.exitCode, next };
  }

  if (result.exitCode !== 0) {
    throw new RunnerFailureError(
      `runner "${runnerId}" exited with code ${result.exitCode}`,
      runnerId,
      attempt,
      { exitCode: result.exitCode },
    );
  }

  return { exitCode: result.exitCode };
}
