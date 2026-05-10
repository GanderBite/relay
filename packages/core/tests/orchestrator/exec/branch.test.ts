import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowDefinitionError, StepFailureError } from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
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
      handoffs: {} as Record<string, unknown>,
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
