/**
 * End-to-end integration tests for cwd resolution in script and branch executors.
 *
 * These tests call executeScript and executeBranch directly (no flow runner
 * plumbing) with a ctx.cwd pointing at a temporary "worktree" directory and
 * verify that the subprocess sees the expected working directory.
 *
 * This file is the natural canary for the wiring in step-registrations.ts —
 * a regression in the step.cwd ?? ctx.cwd ?? runDir resolution chain will
 * surface here before it reaches end-user flows.
 */

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { step } from '../../../src/flow/step.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import { executeBranch } from '../../../src/orchestrator/exec/branch.js';
import { executeScript } from '../../../src/orchestrator/exec/script.js';

describe('cwd integration — executeScript and executeBranch share a worktree ctx.cwd', () => {
  let tmp: string;
  let worktreeDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-cwd-int-'));
    worktreeDir = join(tmp, 'worktree');
    await mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function ctxBase() {
    return {
      runDir: tmp,
      runId: 'r-int',
      logger: createLogger({ flowName: 'f', runId: 'r-int' }),
      abortSignal: new AbortController().signal,
      attempt: 1,
      input: {} as Record<string, unknown>,
      handoffStore: new HandoffStore(tmp),
      flowDir: tmp,
      handoffsDir: join(tmp, 'handoffs'),
      cwd: worktreeDir,
    };
  }

  it('[EXEC-INT-CWD-001] executeScript runs in ctx.cwd (worktree) when step.cwd is absent', async () => {
    const realWorktree = realpathSync(worktreeDir);

    const s = step.script({
      run: ['node', '-e', 'process.stdout.write(process.cwd())'],
    });
    const result = await executeScript(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout ?? '').trim()).toBe(realWorktree);
  });

  it('[EXEC-INT-CWD-002] executeBranch runs in ctx.cwd (worktree) when step.cwd is absent', async () => {
    const realWorktree = realpathSync(worktreeDir);

    const s = step.branch({
      run: [
        'node',
        '-e',
        `process.exit(process.cwd() === ${JSON.stringify(realWorktree)} ? 0 : 1)`,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const result = await executeBranch(s, { ...ctxBase(), stepId: s.id || 's', step: s });
    expect(result.exitCode).toBe(0);
  });

  it('[EXEC-INT-CWD-003] two-step scenario: file written by executeScript in worktreeDir is visible to executeBranch using the same ctx.cwd', async () => {
    // Step 1 (script): write a sentinel file into the worktree directory.
    const sentinelName = 'integration-sentinel.txt';
    const sentinelContent = 'relay-cwd-integration-ok';

    const writeStep = step.script({
      run: [
        'node',
        '-e',
        // Write the sentinel file relative to cwd (which is worktreeDir).
        `require('node:fs').writeFileSync(${JSON.stringify(sentinelName)}, ${JSON.stringify(sentinelContent)})`,
      ],
    });
    const writeResult = await executeScript(writeStep, {
      ...ctxBase(),
      stepId: writeStep.id || 'write',
      step: writeStep,
    });
    expect(writeResult.exitCode).toBe(0);

    // Verify the file actually landed in worktreeDir from the test process side.
    const sentinelPath = join(worktreeDir, sentinelName);
    const onDisk = await readFile(sentinelPath, 'utf8');
    expect(onDisk).toBe(sentinelContent);

    // Step 2 (branch): exit 0 only if the sentinel file exists and has the expected content.
    const readStep = step.branch({
      run: [
        'node',
        '-e',
        `const fs = require('node:fs'); const content = fs.readFileSync(${JSON.stringify(sentinelName)}, 'utf8'); process.exit(content === ${JSON.stringify(sentinelContent)} ? 0 : 1)`,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
    });
    const readResult = await executeBranch(readStep, {
      ...ctxBase(),
      stepId: readStep.id || 'read',
      step: readStep,
    });
    expect(readResult.exitCode).toBe(0);
  });

  it('[EXEC-INT-CWD-004] step.cwd overrides ctx.cwd for both executors independently', async () => {
    const overrideDir = join(tmp, 'override');
    await mkdir(overrideDir, { recursive: true });
    const realOverride = realpathSync(overrideDir);
    const realWorktree = realpathSync(worktreeDir);

    // executeScript with step.cwd pointing at overrideDir — must NOT see worktreeDir.
    const scriptStep_ = step.script({
      run: ['node', '-e', 'process.stdout.write(process.cwd())'],
      cwd: overrideDir,
    });
    const scriptResult = await executeScript(scriptStep_, {
      ...ctxBase(),
      stepId: scriptStep_.id || 's',
      step: scriptStep_,
    });
    expect(scriptResult.exitCode).toBe(0);
    const scriptCwd = String(scriptResult.stdout ?? '').trim();
    expect(scriptCwd).toBe(realOverride);
    expect(scriptCwd).not.toBe(realWorktree);

    // executeBranch with step.cwd pointing at overrideDir — must NOT see worktreeDir.
    const branchStep_ = step.branch({
      run: [
        'node',
        '-e',
        `process.exit(process.cwd() === ${JSON.stringify(realOverride)} ? 0 : 1)`,
      ],
      onExit: { '0': 'continue', '1': 'abort' },
      cwd: overrideDir,
    });
    const branchResult = await executeBranch(branchStep_, {
      ...ctxBase(),
      stepId: branchStep_.id || 'b',
      step: branchStep_,
    });
    expect(branchResult.exitCode).toBe(0);
  });
});
