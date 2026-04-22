import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../logger.js';
import { RunnerFailureError } from '../../errors.js';
import type { ScriptRunnerSpec } from '../../race/types.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { runProcess } from './process.js';
import { splitShell } from './shlex.js';

export interface ScriptExecContext {
  runDir: string;
  runnerId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface ScriptRunnerResult {
  exitCode: number;
  stdout: string | undefined;
  stderr: string | undefined;
  next?: string;
}

export async function executeScript(
  runner: ScriptRunnerSpec,
  ctx: ScriptExecContext,
): Promise<ScriptRunnerResult> {
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

  // user-controlled shell; claude env allowlist does not apply.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const env: Record<string, string> = { ...baseEnv, ...(runner.env ?? {}) };

  const hasArtifact = runner.output?.artifact !== undefined;

  const result = await runProcess({
    cmd,
    args,
    cwd,
    env,
    timeoutMs: runner.timeoutMs,
    abortSignal,
    captureStdout: true,
    captureStderr: true,
    logger,
    runnerId,
  });

  if (hasArtifact && result.stdout !== undefined) {
    const artifactName = runner.output?.artifact;
    if (artifactName !== undefined) {
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const artifactPath = join(artifactsDir, artifactName);
      const writeResult = await atomicWriteText(artifactPath, result.stdout);
      if (writeResult.isErr()) throw writeResult.error;
    }
  }

  const onExit = runner.onExit;
  const exitCodeKey = String(result.exitCode);

  if (onExit !== undefined) {
    const mapped = onExit[exitCodeKey];
    if (mapped !== undefined) {
      const next = mapped === 'abort' || mapped === 'continue' ? undefined : mapped;
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        next,
      };
    }
  }

  if (result.exitCode !== 0) {
    throw new RunnerFailureError(
      `runner "${runnerId}" exited with code ${result.exitCode}`,
      runnerId,
      attempt,
      { exitCode: result.exitCode, stderr: result.stderr ?? '' },
    );
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
