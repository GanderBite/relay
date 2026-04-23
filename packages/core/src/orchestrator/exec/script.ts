import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StepFailureError } from '../../errors.js';
import type { ScriptStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { runProcess } from './process.js';
import { splitShell } from './shlex.js';

export interface ScriptExecContext {
  runDir: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface ScriptStepResult {
  exitCode: number;
  stdout: string | undefined;
  stderr: string | undefined;
  next?: string;
}

export async function executeScript(
  step: ScriptStepSpec,
  ctx: ScriptExecContext,
): Promise<ScriptStepResult> {
  const { runDir, stepId, attempt, abortSignal, logger } = ctx;

  const rawArgs = Array.isArray(step.run) ? step.run : splitShell(step.run);
  const [cmd, ...args] = rawArgs;
  if (cmd === undefined) {
    throw new StepFailureError(`step "${stepId}" has an empty run command`, stepId, attempt);
  }

  const cwd = step.cwd ?? runDir;

  // user-controlled shell; claude env allowlist does not apply.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const env: Record<string, string> = { ...baseEnv, ...(step.env ?? {}) };

  const hasArtifact = step.output?.artifact !== undefined;

  const result = await runProcess({
    cmd,
    args,
    cwd,
    env,
    timeoutMs: step.timeoutMs,
    abortSignal,
    captureStdout: true,
    captureStderr: true,
    logger,
    stepId,
  });

  if (hasArtifact && result.stdout !== undefined) {
    const artifactName = step.output?.artifact;
    if (artifactName !== undefined) {
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const artifactPath = join(artifactsDir, artifactName);
      const writeResult = await atomicWriteText(artifactPath, result.stdout);
      if (writeResult.isErr()) throw writeResult.error;
    }
  }

  const onExit = step.onExit;
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
    throw new StepFailureError(
      `step "${stepId}" exited with code ${result.exitCode}`,
      stepId,
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
