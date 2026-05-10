/**
 * Sprint 5 task_34 + task_35 contract tests.
 * References packages/core/src/orchestrator/exec/script.ts and branch.ts — not yet implemented.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StepFailureError, TimeoutError } from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
import { createLogger } from '../../../src/logger.js';
import { executeBranch } from '../../../src/orchestrator/exec/branch.js';
import { executeScript } from '../../../src/orchestrator/exec/script.js';

describe('executeScript / executeBranch (sprint 5 task_34 + task_35)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-execs-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function ctxBase() {
    return {
      runDir: tmp,
      runId: 'r',
      logger: createLogger({ flowName: 'f', runId: 'r' }),
      abortSignal: new AbortController().signal,
      attempt: 1,
      input: {},
      handoffs: {},
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
    };
  }

  it('[EXEC-SCRIPT-001] spawns a process, captures stdout, returns exit code 0', async () => {
    const s = step.script({ run: 'node -e "console.log(1+1)"' });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('2');
  });

  it('[EXEC-SCRIPT-002] shlex-splits a string run, preserving quoted segments', async () => {
    const s = step.script({ run: 'node -e "console.log(\\"hello world\\")"' });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('hello world');
  });

  it('[EXEC-SCRIPT-003] timeoutMs kills the child and throws TimeoutError', async () => {
    const s = step.script({ run: 'sleep 10', timeoutMs: 200 });
    const started = Date.now();
    await expect(
      executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('[EXEC-SCRIPT-004] passes full process.env + step.env (not the Claude allowlist)', async () => {
    process.env.RELAY_TEST_NODE_ENV = 'outerval';
    const s = step.script({
      run: 'node -e "console.log(process.env.RELAY_TEST_NODE_ENV + \\":\\" + process.env.CUSTOM)"',
      env: { CUSTOM: 'x' },
    });
    try {
      const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
      expect(String(result.stdout ?? '')).toContain('outerval:x');
    } finally {
      delete process.env.RELAY_TEST_NODE_ENV;
    }
  });

  it('[EXEC-SCRIPT-005] onExit map routes to a named next step and suppresses failure', async () => {
    const s = step.script({ run: 'node -e "process.exit(2)"', onExit: { '2': 'altStep' } });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(2);
    const next = (result as { next?: string }).next;
    expect(next).toBe('altStep');
  });

  it('[EXEC-SCRIPT-006] executeBranch returns only exit code (no stdout/artifact)', async () => {
    const s = step.branch({
      run: 'node -e "process.exit(0)"',
      onExit: { '0': 'nextStep', '1': 'abort' },
    });
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    const asObj = result as Record<string, unknown>;
    expect(asObj.stdout).toBeUndefined();
    expect((result as { next?: string }).next).toBe('nextStep');
  });

  it('[EXEC-SCRIPT-007] writes <runDir>/live/<stepId>.stderr.txt when script exits non-zero with stderr', async () => {
    // Use array run to avoid shell-metachar rejection.
    const s = step.script({
      run: ['node', '-e', 'process.stderr.write("fatal error\\n"); process.exit(1)'],
    });
    const stepId = s.id || 's';
    await expect(executeScript(s, { ...ctxBase(), stepId, step: s })).rejects.toBeInstanceOf(
      StepFailureError,
    );

    const stderrFile = join(tmp, 'live', `${stepId}.stderr.txt`);
    const content = await readFile(stderrFile, 'utf8');
    expect(content).toContain('fatal error');
  });

  it('[EXEC-SCRIPT-008] does not write stderr sidecar file when script exits 0', async () => {
    // Use array run to avoid shell-metachar rejection.
    const s = step.script({
      run: ['node', '-e', 'process.stderr.write("info\\n"); process.exit(0)'],
    });
    const stepId = s.id || 's';
    const result = await executeScript(s, { ...ctxBase(), stepId, step: s });
    expect(result.exitCode).toBe(0);

    const stderrFile = join(tmp, 'live', `${stepId}.stderr.txt`);
    await expect(access(stderrFile)).rejects.toThrow();
  });

  it('[EXEC-SCRIPT-ENV-001] {{input.repo}} in string-form run expands before splitShell', async () => {
    const s = step.script({ run: 'node -e "console.log(process.argv[1])" {{input.repo}}' });
    const result = await executeScript(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      input: { repo: 'my-repo' },
    });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('my-repo');
  });

  it('[EXEC-SCRIPT-ENV-002] RELAY_RUN_DIR is set in the process env passed to spawn', async () => {
    // The script reads RELAY_RUN_DIR from its own process.env; we verify the
    // executor injected it by printing it to stdout.
    const s = step.script({
      run: 'node -e "console.log(process.env.RELAY_RUN_DIR)"',
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    // tmp is the runDir; RELAY_RUN_DIR must equal it.
    expect(String(result.stdout ?? '').trim()).toBe(tmp);
  });

  it('[EXEC-SCRIPT-ENV-003] step env value overrides RELAY_RUN_DIR', async () => {
    const overrideValue = '/custom/run/dir';
    const s = step.script({
      run: 'node -e "console.log(process.env.RELAY_RUN_DIR)"',
      env: { RELAY_RUN_DIR: overrideValue },
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe(overrideValue);
  });

  it('[EXEC-SCRIPT-009] StepFailureError is still thrown even if the stderr sidecar write fails', async () => {
    // Use a runDir path whose live/ sub-directory cannot be created — we use a
    // file as the parent so mkdir fails with ENOTDIR.
    const { writeFile: fsWriteFile } = await import('node:fs/promises');
    const blockingFile = join(tmp, 'live');
    await fsWriteFile(blockingFile, 'blocker', 'utf8');

    const s = step.script({
      run: ['node', '-e', 'process.stderr.write("err\\n"); process.exit(1)'],
    });
    const stepId = s.id || 's';
    const ctx = {
      ...ctxBase(),
      runDir: tmp,
      stepId,
      step: s,
    };

    // The executor swallows the sidecar write failure (unwrapOr) and must
    // still throw StepFailureError for the non-zero exit.
    await expect(executeScript(s, ctx)).rejects.toBeInstanceOf(StepFailureError);
  });
});
