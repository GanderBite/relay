import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowDefinitionError,
  HandoffNotFoundError,
  StepFailureError,
} from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import { executeBranch } from '../../../src/orchestrator/exec/branch.js';

describe('executeBranch structured env', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-branch-env-'));
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
      handoffStore: new HandoffStore(tmp),
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
    };
  }

  it('resolves env { from: "input.repo" } and exposes it to the child process', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(process.env.REPO === "my-repo" ? 0 : 7)'],
      env: { REPO: { from: 'input.repo' } },
      onExit: { '0': 'continue', '7': 'abort' },
    });
    const result = await executeBranch(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      input: { repo: 'my-repo' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a StepFailureError when a required source resolves to undefined', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(0)'],
      env: { REPO: { from: 'input.missing', required: true } },
      onExit: { '0': 'continue' },
    });
    await expect(
      executeBranch(s, {
        ...ctxBase(),
        stepId: s.id || 's',
        step: s,
        input: {},
      }),
    ).rejects.toBeInstanceOf(StepFailureError);
  });

  it('injects RELAY_RUN_DIR into the child process env', async () => {
    const s = step.branch({
      run: [
        'node',
        '-e',
        'process.exit(process.env.RELAY_RUN_DIR === process.argv[1] ? 0 : 1)',
        tmp,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
    });
    expect(result.exitCode).toBe(0);
  });

  it('StepFailureError from resolveScriptEnv preserves the FlowDefinitionError cause', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(0)'],
      env: { REPO: { from: 'input.missing', required: true } },
      onExit: { '0': 'continue' },
    });
    let caught: unknown;
    try {
      await executeBranch(s, {
        ...ctxBase(),
        stepId: s.id || 's',
        step: s,
        input: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepFailureError);
    const err = caught as StepFailureError;
    expect(err.details?.cause).toBeInstanceOf(FlowDefinitionError);
  });

  it('templates {{input.x}} in string-form run before splitShell', async () => {
    const s = step.branch({
      run: 'node -e "process.exit(process.argv[1] === \\"my-repo\\" ? 0 : 1)" {{input.repo}}',
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      input: { repo: 'my-repo' },
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('executeBranch -- cwd resolution', () => {
  let tmp: string;
  let worktreeDir: string;
  let overrideDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-branch-cwd-'));
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
      input: {} as Record<string, unknown>,
      handoffStore: new HandoffStore(tmp),
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
    };
  }

  it('[EXEC-BRANCH-CWD-001] ctx.cwd is used as the effective cwd when step.cwd is absent', async () => {
    const { realpathSync } = await import('node:fs');
    const realWorktree = realpathSync(worktreeDir);

    // Exit 0 when process.cwd() matches the expected worktree path, else exit 1.
    const s = step.branch({
      run: [
        'node',
        '-e',
        `process.exit(process.cwd() === ${JSON.stringify(realWorktree)} ? 0 : 1)`,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      cwd: worktreeDir,
    });
    expect(result.exitCode).toBe(0);
  });

  it('[EXEC-BRANCH-CWD-002] step.cwd wins over ctx.cwd when both are set', async () => {
    const { realpathSync } = await import('node:fs');
    const realOverride = realpathSync(overrideDir);

    const s = step.branch({
      run: [
        'node',
        '-e',
        `process.exit(process.cwd() === ${JSON.stringify(realOverride)} ? 0 : 1)`,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
      cwd: overrideDir,
    });
    const result = await executeBranch(s, {
      ...ctxBase(),
      stepId: s.id || 's',
      step: s,
      cwd: worktreeDir,
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('executeBranch -- handoff env resolution', () => {
  let tmp: string;
  let store: HandoffStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-branch-henv-'));
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

  it('[EXEC-BRANCH-HENV-001] from: handoff.<id>.<path>, required: true with written handoff passes nested value to subprocess', async () => {
    const writeResult = await store.write('my_step', { result: { wave_id: 'w1' } });
    expect(writeResult.isOk()).toBe(true);

    const s = step.branch({
      run: ['node', '-e', 'process.exit(process.env.WAVE_ID === "w1" ? 0 : 1)'],
      env: { WAVE_ID: { from: 'handoff.my_step.result.wave_id', required: true } },
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
  });

  it('[EXEC-BRANCH-HENV-002] from: handoff.<id>.<path>, required: true with no handoff written throws StepFailureError with not-found wording', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(0)'],
      env: { KEY: { from: 'handoff.missing_step.foo', required: true } },
      onExit: { '0': 'continue' },
    });
    await expect(
      executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof StepFailureError)) return false;
      return e.message.includes('handoff "missing_step" not found');
    });
  });

  it('[EXEC-BRANCH-HENV-003] from: handoff.<id> (bare, no nested path), required: false resolves to non-empty string', async () => {
    const writeResult = await store.write('step_a', { status: 'done' });
    expect(writeResult.isOk()).toBe(true);

    // The env var is set to a non-empty string (JSON of the handoff object).
    // We verify this by checking the exit code of a node process that exits 0
    // only when STEP_A_VAL is non-empty.
    const s = step.branch({
      run: [
        'node',
        '-e',
        'process.exit(process.env.STEP_A_VAL && process.env.STEP_A_VAL.length > 0 ? 0 : 1)',
      ],
      env: { STEP_A_VAL: { from: 'handoff.step_a', required: false } },
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
  });

  it('[EXEC-BRANCH-HENV-004] from: handoff.<id>.<path> with nonexistent nested key: required:false gives empty string, required:true throws StepFailureError', async () => {
    const writeResult = await store.write('step_b', { x: 1 });
    expect(writeResult.isOk()).toBe(true);

    // required: false — subprocess receives MISSING_KEY="" (empty string), exits 0
    const sOptional = step.branch({
      run: ['node', '-e', 'process.exit(process.env.MISSING_KEY === "" ? 0 : 1)'],
      env: { MISSING_KEY: { from: 'handoff.step_b.nonexistent', required: false } },
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const resultOptional = await executeBranch(sOptional, {
      ...ctxBase(),
      stepId: sOptional.id || 's1',
      step: sOptional,
    });
    expect(resultOptional.exitCode).toBe(0);

    // required: true — throws StepFailureError with the exact wording
    const sRequired = step.branch({
      run: ['node', '-e', 'process.exit(0)'],
      env: { MISSING_KEY: { from: 'handoff.step_b.nonexistent', required: true } },
      onExit: { '0': 'continue' },
    });
    await expect(
      executeBranch(sRequired, { ...ctxBase(), stepId: sRequired.id || 's2', step: sRequired }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof StepFailureError)) return false;
      return e.message.includes(
        'handoff "step_b" exists but path "nonexistent" resolved to undefined',
      );
    });
  });

  it('[EXEC-BRANCH-HENV-005] from: handoff.<id>.<path>, required: false with no handoff written succeeds with empty string', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(process.env.X === "" ? 0 : 1)'],
      env: { X: { from: 'handoff.nope.path', required: false } },
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
  });

  it('[EXEC-BRANCH-HENV-CAUSE] StepFailureError from handoff pre-load preserves the HandoffNotFoundError cause', async () => {
    const s = step.branch({
      run: ['node', '-e', 'process.exit(0)'],
      env: { KEY: { from: 'handoff.missing_step.foo', required: true } },
      onExit: { '0': 'continue' },
    });
    let caught: unknown;
    try {
      await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepFailureError);
    const sfe = caught as StepFailureError;
    expect(sfe.details?.cause).toBeInstanceOf(HandoffNotFoundError);
  });
});
