import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StepFailureError } from '../../errors.js';
import type { ScriptStepSpec } from '../../flow/types.js';
import type { Logger } from '../../logger.js';
import { renderTemplate } from '../../template.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { runProcess } from './process.js';
import { splitShell } from './shlex.js';

export interface ScriptExecContext {
  runDir: string;
  runId: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  logger: Logger;
  // Flow input record templated into `run` argv via {{input.x}}. Plain object
  // when the flow declared no input schema or the input was non-object.
  input: Record<string, unknown>;
  // Loaded handoff values keyed by handoff id. Spread into the template root
  // so authors can reference {{my_handoff.field}} in run argv.
  handoffs: Record<string, unknown>;
  // Flow package directory — exposed as {{flowDir}} so scripts can address
  // bundled helper paths under the flow's own tree.
  flowDir: string;
  // Per-run handoffs directory (typically <runDir>/handoffs) — exposed as
  // {{handoffsDir}} so scripts can read raw handoff files when needed.
  handoffsDir: string;
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
  const { runDir, runId, stepId, attempt, abortSignal, logger } = ctx;

  // Template context for run argv. `input` is namespaced (`{{input.repo}}`)
  // while handoff values are spread at the root so authors can reference
  // `{{my_handoff_id}}` directly — matching the prompt-step convention.
  const templateCtx: Record<string, unknown> = {
    input: ctx.input,
    ...ctx.handoffs,
    runDir: ctx.runDir,
    flowDir: ctx.flowDir,
    handoffsDir: ctx.handoffsDir,
  };

  const renderOrThrow = (raw: string): string => {
    const rendered = renderTemplate(raw, templateCtx);
    if (rendered.isErr()) {
      throw new StepFailureError(
        `step "${stepId}" run template render failed: ${rendered.error.message}`,
        stepId,
        attempt,
        { runId },
      );
    }
    return rendered.value;
  };

  const rawArgs = Array.isArray(step.run)
    ? step.run.map(renderOrThrow)
    : splitShell(renderOrThrow(step.run));
  const [cmd, ...args] = rawArgs;
  if (cmd === undefined) {
    throw new StepFailureError(`step "${stepId}" has an empty run command`, stepId, attempt, {
      runId,
    });
  }

  const cwd = step.cwd ?? runDir;

  // user-controlled shell; claude env allowlist does not apply.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const stepEnv: Record<string, string> = Object.fromEntries(
    Object.entries(step.env ?? {}).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
  );
  const env: Record<string, string> = { ...baseEnv, ...stepEnv };

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
        ...(next !== undefined ? { next } : {}),
      };
    }
  }

  if (result.exitCode !== 0) {
    if (result.stderr && result.stderr.length > 0) {
      const stderrPath = join(runDir, 'live', `${stepId}.stderr.txt`);
      await atomicWriteText(stderrPath, result.stderr).unwrapOr(undefined);
    }
    throw new StepFailureError(
      `step "${stepId}" exited with code ${result.exitCode}`,
      stepId,
      attempt,
      { exitCode: result.exitCode, stderr: result.stderr ?? '', runId },
    );
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
