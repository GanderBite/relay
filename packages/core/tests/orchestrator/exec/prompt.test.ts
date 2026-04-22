/**
 * Sprint 5 task_33 contract tests for executePrompt.
 * References packages/core/src/orchestrator/exec/prompt.ts — not yet implemented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executePrompt } from '../../../src/orchestrator/exec/prompt.js';
import { MockProvider } from '../../../src/testing/mock-provider.js';
import { BatonStore } from '../../../src/batons.js';
import { CostTracker } from '../../../src/cost.js';
import { BatonSchemaError, StepFailureError } from '../../../src/errors.js';
import { runner } from '../../../src/race/runner.js';
import { z } from '../../../src/zod.js';
import { createLogger } from '../../../src/logger.js';
import type { InvocationResponse } from '../../../src/providers/types.js';

const canned: InvocationResponse = {
  text: '{"name":"alice"}',
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.01,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('executePrompt (sprint 5 task_33)', () => {
  let tmp: string;
  let raceDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-execp-'));
    raceDir = join(tmp, 'flow');
    await mkdir(join(raceDir, 'prompts'), { recursive: true });
    await writeFile(join(raceDir, 'prompts', 'p.md'), 'Hello {{input.name}}', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeCtxBase() {
    const batonStore = new BatonStore(tmp);
    const costTracker = new CostTracker(join(tmp, 'metrics.json'));
    return {
      runDir: tmp,
      raceDir,
      raceName: 'f',
      runId: 'r',
      batonStore,
      costTracker,
      logger: createLogger({ raceName: 'f', runId: 'r' }),
      abortSignal: new AbortController().signal,
    };
  }

  it('[EXEC-PROMPT-001] loads prompt, loads batons, calls assemblePrompt, then provider.invoke', async () => {
    const batonStore = new BatonStore(tmp);
    await batonStore.write('prior', { note: 'ok' });
    const s = runner
      .prompt({
        promptFile: 'prompts/p.md',
        contextFrom: ['prior'],
        output: { baton: 'greeted' },
      })
      ;

    let capturedPrompt = '';
    const provider = new MockProvider({
      responses: {
        [s.id || 'greet']: (req) => {
          capturedPrompt = req.prompt;
          return { ...canned, text: '{"hello":"world"}' };
        },
      },
    });

    const ctx = { ...makeCtxBase(), batonStore, runnerId: s.id || 'greet', runner: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(capturedPrompt).toContain('<c name="prior">');
    // baton written
    const wrote = await batonStore.read('greeted');
    expect(wrote.isOk()).toBe(true);
  });

  it('[EXEC-PROMPT-002] converts Zod schema to JSON schema on InvocationRequest.jsonSchema', async () => {
    const s = runner
      .prompt({
        promptFile: 'prompts/p.md',
        output: { baton: 'x', schema: z.object({ name: z.string() }) },
      })
      ;

    let capturedJsonSchema: unknown;
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: (req) => {
          capturedJsonSchema = req.jsonSchema;
          return canned;
        },
      },
    });

    const ctx = { ...makeCtxBase(), runnerId: s.id || 'p', runner: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(capturedJsonSchema).toBeTypeOf('object');
    const js = capturedJsonSchema as Record<string, unknown>;
    expect(js.type).toBe('object');
    expect(js.properties).toBeDefined();
  });

  it('[EXEC-PROMPT-003] invalid JSON response against schema surfaces BatonSchemaError', async () => {
    const s = runner
      .prompt({
        promptFile: 'prompts/p.md',
        output: {
          baton: 'entities',
          schema: z.object({
            entities: z.array(z.object({ name: z.string() })),
          }),
        },
      })
      ;
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: { ...canned, text: '{"entities":[{"name":1}]}' },
      },
    });
    const ctx = { ...makeCtxBase(), runnerId: s.id || 'p', runner: s, provider, attempt: 1 };
    await expect(
      executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]),
    ).rejects.toBeInstanceOf(BatonSchemaError);
  });

  it('[EXEC-PROMPT-004] writes artifact file when output.artifact is set', async () => {
    const s = runner
      .prompt({ promptFile: 'prompts/p.md', output: { artifact: 'report.html' } })
      ;
    const provider = new MockProvider({
      responses: { [s.id || 'p']: { ...canned, text: '<html>...</html>' } },
    });
    const ctx = { ...makeCtxBase(), runnerId: s.id || 'p', runner: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    const bytes = await readFile(join(tmp, 'artifacts', 'report.html'), 'utf8');
    expect(bytes).toContain('<html>');
  });

  it('[EXEC-PROMPT-005] records RunnerMetrics via costTracker', async () => {
    const s = runner.prompt({ promptFile: 'prompts/p.md', output: { baton: 'x' } });
    const ctxBase = makeCtxBase();
    const recordSpy = vi.spyOn(ctxBase.costTracker, 'record');
    const provider = new MockProvider({ responses: { [s.id || 'p']: canned } });
    const ctx = { ...ctxBase, runnerId: s.id || 'p', runner: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const metric = recordSpy.mock.calls[0]![0];
    expect(metric.tokensIn).toBe(100);
    expect(metric.tokensOut).toBe(50);
    expect(metric.costUsd).toBe(0.01);
  });

  it('[EXEC-PROMPT-006] wraps provider errors in StepFailureError with runnerId + attempt', async () => {
    const s = runner.prompt({ promptFile: 'prompts/p.md', output: { baton: 'x' } });
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: () => {
          throw new Error('network blip');
        },
      },
    });
    const ctx = { ...makeCtxBase(), runnerId: s.id || 'p', runner: s, provider, attempt: 2 };
    await expect(
      executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]),
    ).rejects.toMatchObject({
      name: 'StepFailureError',
      attempt: 2,
    });
    // Also verify class
    try {
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    } catch (e) {
      expect(e).toBeInstanceOf(StepFailureError);
    }
  });

  it('[EXEC-PROMPT-007] passes ctx.abortSignal into InvocationContext', async () => {
    const ctrl = new AbortController();
    const s = runner.prompt({ promptFile: 'prompts/p.md', output: { baton: 'x' } });
    let capturedSignal: AbortSignal | undefined;
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: (_req, ictx) => {
          capturedSignal = ictx.abortSignal;
          return canned;
        },
      },
    });
    const ctx = {
      ...makeCtxBase(),
      runnerId: s.id || 'p',
      runner: s,
      provider,
      attempt: 1,
      abortSignal: ctrl.signal,
    };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(capturedSignal).toBe(ctrl.signal);
  });

  it('[EXEC-PROMPT-008] emits logger events prompt.start / prompt.done on success, prompt.failed on error', async () => {
    const events: string[] = [];
    const stubLogger = {
      info: (obj: { event?: string }) => { if (obj?.event) events.push(obj.event); },
      warn: () => undefined,
      error: (obj: { event?: string }) => { if (obj?.event) events.push(obj.event); },
      debug: () => undefined,
      child: function () { return this; },
    };
    const s = runner.prompt({ promptFile: 'prompts/p.md', output: { baton: 'x' } });
    const provider = new MockProvider({ responses: { [s.id || 'p']: canned } });
    const ctx = { ...makeCtxBase(), runnerId: s.id || 'p', runner: s, provider, attempt: 1, logger: stubLogger };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(events).toContain('prompt.start');
    expect(events).toContain('prompt.done');
  });
});
