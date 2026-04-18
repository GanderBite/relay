import type { Logger } from '../../logger.js';
import { StepFailureError } from '../../errors.js';
import type { BranchStepSpec } from '../../flow/types.js';
import { runProcess } from './process.js';

export interface BranchExecContext {
  runDir: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  step?: unknown; // reserved for future convenience; not used by executeBranch
}

export interface BranchStepResult {
  exitCode: number;
  next?: string;
}

type BranchStepInput = Omit<BranchStepSpec, 'id'> & { id?: string };

/**
 * Parse a shell command string into [cmd, ...args] respecting single and
 * double quotes. Shared logic with executeScript; extracted to process.ts
 * handles subprocess concerns. This inline version avoids a circular import.
 *
 * No shell interpolation is performed — intentional: branch steps run with
 * shell: false for safety and determinism.
 */
function splitShell(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === undefined) { i++; continue; }
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && cmd[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (ch === '\\' && quote === "'" && cmd[i + 1] === "'") {
        current += "'";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
    i++;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

export async function executeBranch(
  step: BranchStepInput,
  ctx: BranchExecContext,
): Promise<BranchStepResult> {
  const { runDir, stepId, attempt, abortSignal, logger } = ctx;

  const rawArgs = Array.isArray(step.run) ? step.run : splitShell(step.run);
  const [cmd, ...args] = rawArgs;
  if (cmd === undefined) {
    throw new StepFailureError(
      `step "${stepId}" has an empty run command`,
      stepId,
      attempt,
    );
  }

  const cwd = step.cwd ?? runDir;

  // user-controlled shell; claude env allowlist does not apply.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
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
    return { exitCode: result.exitCode, next };
  }

  if (result.exitCode !== 0) {
    throw new StepFailureError(
      `step "${stepId}" exited with code ${result.exitCode}`,
      stepId,
      attempt,
      { exitCode: result.exitCode },
    );
  }

  return { exitCode: result.exitCode };
}
