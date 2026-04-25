import { StepFailureError } from '../../errors.js';
import type { BranchStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';
import { runProcess } from './process.js';
import { splitShell } from './shlex.js';

export interface BranchExecContext {
  runDir: string;
  runId: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface BranchStepResult {
  exitCode: number;
  next?: string;
}

export async function executeBranch(
  step: BranchStepSpec,
  ctx: BranchExecContext,
): Promise<BranchStepResult> {
  const { runDir, runId, stepId, attempt, abortSignal, logger } = ctx;

  const rawArgs = Array.isArray(step.run) ? step.run : splitShell(step.run);
  const [cmd, ...args] = rawArgs;
  if (cmd === undefined) {
    throw new StepFailureError(`step "${stepId}" has an empty run command`, stepId, attempt, {
      runId,
    });
  }

  const cwd = step.cwd ?? runDir;

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const env: Record<string, string> = { ...baseEnv, ...(step.env ?? {}) };

  const result = await runProcess({
    cmd,
    args,
    cwd,
    env,
    timeoutMs: step.timeoutMs,
    abortSignal,
    captureStdout: false,
    captureStderr: false,
    logger,
    stepId,
  });

  const exitCodeKey = String(result.exitCode);
  const mapped = step.onExit[exitCodeKey];

  if (mapped !== undefined) {
    const next = mapped === 'abort' || mapped === 'continue' ? undefined : mapped;
    return {
      exitCode: result.exitCode,
      ...(next !== undefined ? { next } : {}),
    };
  }

  if (result.exitCode !== 0) {
    throw new StepFailureError(
      `step "${stepId}" exited with code ${result.exitCode}`,
      stepId,
      attempt,
      { exitCode: result.exitCode, runId },
    );
  }

  return { exitCode: result.exitCode };
}
