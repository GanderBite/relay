/**
 * Sprint 5 task_34 + task_35 contract tests.
 * References packages/core/src/orchestrator/exec/script.ts and branch.ts — not yet implemented.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowDefinitionError,
  HandoffNotFoundError,
  StepFailureError,
  TimeoutError,
} from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
import { HandoffStore } from '../../../src/handoffs.js';
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
      handoffStore: new HandoffStore(tmp),
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

  it('[EXEC-SCRIPT-ENV-CAUSE] StepFailureError from resolveScriptEnv preserves the FlowDefinitionError cause', async () => {
    const s = step.script({
      run: ['node', '-e', 'process.exit(0)'],
      env: { REPO: { from: 'input.missing', required: true } },
    });
    let caught: unknown;
    try {
      await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s, input: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepFailureError);
    const err = caught as StepFailureError;
    expect(err.details?.cause).toBeInstanceOf(FlowDefinitionError);
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

describe('executeScript -- cwd resolution', () => {
  let tmp: string;
  let worktreeDir: string;
  let overrideDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-script-cwd-'));
    worktreeDir = join(tmp, 'worktree');
    overrideDir = join(tmp, 'override');
    const { mkdir: fsMkdir } = await import('node:fs/promises');
    await fsMkdir(worktreeDir, { recursive: true });
    await fsMkdir(overrideDir, { recursive: true });
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
      handoffStore: new HandoffStore(tmp),
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
    };
  }

  it('[EXEC-SCRIPT-CWD-001] ctx.cwd is used as the effective cwd when step.cwd is absent', async () => {
    const { realpathSync } = await import('node:fs');
    const realWorktree = realpathSync(worktreeDir);

    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(process.cwd())'],
    });
    const result = await executeScript(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      cwd: worktreeDir,
    });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe(realWorktree);
  });

  it('[EXEC-SCRIPT-CWD-002] step.cwd wins over ctx.cwd when both are set', async () => {
    const { realpathSync } = await import('node:fs');
    const realOverride = realpathSync(overrideDir);

    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(process.cwd())'],
      cwd: overrideDir,
    });
    const result = await executeScript(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      cwd: worktreeDir,
    });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe(realOverride);
  });
});

describe('executeScript -- handoff env resolution', () => {
  let tmp: string;
  let store: HandoffStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-execs-henv-'));
    store = new HandoffStore(tmp);
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
      input: {} as Record<string, unknown>,
      handoffStore: store,
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
    };
  }

  it('[EXEC-SCRIPT-HENV-001] from: handoff.<id>.<path>, required: true with written handoff resolves nested value', async () => {
    const writeResult = await store.write('my_step', { result: { wave_id: 'w1' } });
    expect(writeResult.isOk()).toBe(true);

    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(process.env.WAVE_ID)'],
      env: { WAVE_ID: { from: 'handoff.my_step.result.wave_id', required: true } },
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('w1');
  });

  it('[EXEC-SCRIPT-HENV-002] from: handoff.<id>.<path>, required: true with no handoff written throws StepFailureError with not-found wording', async () => {
    const s = step.script({
      run: ['node', '-e', 'process.exit(0)'],
      env: { KEY: { from: 'handoff.missing_step.foo', required: true } },
    });
    await expect(
      executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof StepFailureError)) return false;
      return e.message.includes('handoff "missing_step" not found');
    });
  });

  it('[EXEC-SCRIPT-HENV-003] from: handoff.<id> (bare, no nested path), required: false resolves to non-empty JSON string', async () => {
    const writeResult = await store.write('step_a', { status: 'done' });
    expect(writeResult.isOk()).toBe(true);

    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(process.env.STEP_A_VAL)'],
      env: { STEP_A_VAL: { from: 'handoff.step_a', required: false } },
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    const val = String(result.stdout ?? '');
    expect(val.length).toBeGreaterThan(0);
  });

  it('[EXEC-SCRIPT-HENV-004] from: handoff.<id>.<path> with nonexistent nested key: required:false gives empty string, required:true throws StepFailureError', async () => {
    const writeResult = await store.write('step_b', { x: 1 });
    expect(writeResult.isOk()).toBe(true);

    // required: false — empty string passed as env var
    const sOptional = step.script({
      run: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env.MISSING_KEY === ""))'],
      env: { MISSING_KEY: { from: 'handoff.step_b.nonexistent', required: false } },
    });
    const resultOptional = await executeScript(sOptional, {
      ...ctxBase(),
      stepId: sOptional.id || 's1',
      step: sOptional,
    });
    expect(resultOptional.exitCode).toBe(0);
    expect(String(resultOptional.stdout ?? '')).toContain('true');

    // required: true — throws StepFailureError with the exact wording
    const sRequired = step.script({
      run: ['node', '-e', 'process.exit(0)'],
      env: { MISSING_KEY: { from: 'handoff.step_b.nonexistent', required: true } },
    });
    await expect(
      executeScript(sRequired, { ...ctxBase(), stepId: sRequired.id || 's2', step: sRequired }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof StepFailureError)) return false;
      return e.message.includes(
        'handoff "step_b" exists but path "nonexistent" resolved to undefined',
      );
    });
  });

  it('[EXEC-SCRIPT-HENV-005] from: handoff.<id>.<path>, required: false with no handoff written succeeds with empty string', async () => {
    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env.X === ""))'],
      env: { X: { from: 'handoff.nope.path', required: false } },
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('true');
  });

  it('[EXEC-SCRIPT-HENV-CAUSE] StepFailureError from handoff pre-load preserves the HandoffNotFoundError cause', async () => {
    const s = step.script({
      run: ['node', '-e', 'process.exit(0)'],
      env: { KEY: { from: 'handoff.missing_step.foo', required: true } },
    });
    let caught: unknown;
    try {
      await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepFailureError);
    const sfe = caught as StepFailureError;
    expect(sfe.details?.cause).toBeInstanceOf(HandoffNotFoundError);
  });
});
