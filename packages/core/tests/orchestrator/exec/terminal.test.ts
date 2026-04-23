/**
 * Sprint 5 task_37 contract tests for executeTerminal.
 * References packages/core/src/orchestrator/exec/terminal.ts — not yet implemented.
 */
import { describe, expect, it, vi } from 'vitest';
import { step } from '../../../src/flow/step.js';
import { executeTerminal } from '../../../src/orchestrator/exec/terminal.js';

function stubLogger() {
  const calls: { level: string; payload: unknown }[] = [];
  const logger = {
    info: (...args: unknown[]) => calls.push({ level: 'info', payload: args }),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: function () {
      return this;
    },
  };
  return { logger, calls };
}

describe('executeTerminal (sprint 5 task_37)', () => {
  it('[EXEC-TERMINAL-001] marks run succeeded and returns a terminal sentinel', async () => {
    const { logger, calls } = stubLogger();
    const s = step.terminal({ message: 'done' });
    const ctx = {
      stepId: s.id || 's',
      step: s,
      attempt: 1,
      abortSignal: new AbortController().signal,
      logger,
    } as unknown as Parameters<typeof executeTerminal>[1];
    const result = await executeTerminal(s, ctx);
    expect((result as { terminal: boolean }).terminal).toBe(true);
    expect((result as { exitCode: number }).exitCode).toBe(0);
    const sawMessage = calls.some((c) => JSON.stringify(c.payload).includes('done'));
    expect(sawMessage).toBe(true);
  });

  it('[EXEC-TERMINAL-002] propagates non-zero exitCode through the sentinel', async () => {
    const { logger } = stubLogger();
    const s = step.terminal({ exitCode: 2 });
    const ctx = {
      stepId: s.id || 's',
      step: s,
      attempt: 1,
      abortSignal: new AbortController().signal,
      logger,
    } as unknown as Parameters<typeof executeTerminal>[1];
    const result = await executeTerminal(s, ctx);
    expect((result as { terminal: boolean }).terminal).toBe(true);
    expect((result as { exitCode: number }).exitCode).toBe(2);
  });
});
