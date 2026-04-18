import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../logger.js';
import { StepFailureError } from '../../errors.js';
import type { ScriptStepSpec } from '../../flow/types.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { runProcess } from './process.js';

export interface ScriptExecContext {
  runDir: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  step?: unknown; // reserved for future convenience; not used by executeScript
}

export interface ScriptStepResult {
  exitCode: number;
  stdout: string | undefined;
  stderr: string | undefined;
  next?: string;
}

type ScriptStepInput = Omit<ScriptStepSpec, 'id'> & { id?: string };

/**
 * Parse a shell command string into [cmd, ...args] respecting single and
 * double quotes. No shell interpolation is performed — this is intentional:
 * script steps run with shell: false for safety and determinism.
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

export async function executeScript(
  step: ScriptStepInput,
  ctx: ScriptExecContext,
): Promise<ScriptStepResult> {
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
