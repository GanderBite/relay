/**
 * Sprint 5 task_34 + task_35 contract tests.
 * References packages/core/src/runner/exec/script.ts and branch.ts — not yet implemented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeScript } from '../../../src/runner/exec/script.js';
import { executeBranch } from '../../../src/runner/exec/branch.js';
import { step } from '../../../src/flow/step.js';
import { TimeoutError } from '../../../src/errors.js';
import { createLogger } from '../../../src/logger.js';

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
      logger: createLogger({ flowName: 'f', runId: 'r' }),
      abortSignal: new AbortController().signal,
      attempt: 1,
    };
  }

  it('[EXEC-SCRIPT-001] spawns a process, captures stdout, returns exit code 0', async () => {
    const s = step.script({ run: 'node -e "console.log(1+1)"' })._unsafeUnwrap();
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('2');
  });

  it('[EXEC-SCRIPT-002] shlex-splits a string run, preserving quoted segments', async () => {
    const s = step
      .script({ run: 'node -e "console.log(\\"hello world\\")"' })
      ._unsafeUnwrap();
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '')).toContain('hello world');
  });

  it('[EXEC-SCRIPT-003] timeoutMs kills the child and throws TimeoutError', async () => {
    const s = step.script({ run: 'sleep 10', timeoutMs: 200 })._unsafeUnwrap();
    const started = Date.now();
    await expect(executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('[EXEC-SCRIPT-004] passes full process.env + step.env (not the Claude allowlist)', async () => {
    process.env.RELAY_TEST_NODE_ENV = 'outerval';
    const s = step
      .script({
        run: 'node -e "console.log(process.env.RELAY_TEST_NODE_ENV + \\":\\" + process.env.CUSTOM)"',
        env: { CUSTOM: 'x' },
      })
      ._unsafeUnwrap();
    try {
      const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
      expect(String(result.stdout ?? '')).toContain('outerval:x');
    } finally {
      delete process.env.RELAY_TEST_NODE_ENV;
    }
  });

  it('[EXEC-SCRIPT-005] onExit map routes to a named next step and suppresses failure', async () => {
    const s = step
      .script({ run: 'node -e "process.exit(2)"', onExit: { '2': 'altStep' } })
      ._unsafeUnwrap();
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(2);
    const next = (result as { next?: string }).next;
    expect(next).toBe('altStep');
  });

  it('[EXEC-SCRIPT-006] executeBranch returns only exit code (no stdout/artifact)', async () => {
    const s = step
      .branch({ run: 'node -e "process.exit(0)"', onExit: { '0': 'nextStep', '1': 'abort' } })
      ._unsafeUnwrap();
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    const asObj = result as Record<string, unknown>;
    expect(asObj.stdout).toBeUndefined();
    expect((result as { next?: string }).next).toBe('nextStep');
  });
});
