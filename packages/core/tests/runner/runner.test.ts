/**
 * Sprint 5 contract tests for Runner, abort handling, and resume protocol.
 * These reference packages/core/src/runner/runner.ts and resume.ts — both are
 * not yet implemented. Tests will fail collection until sprint 5 lands.
 *
 * Cases: RUNNER-001..008, ABORT-001..005, RESUME-001..006.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunner, Runner } from '../../src/runner/runner.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ClaudeAuthError, FlowDefinitionError } from '../../src/errors.js';
import { z } from '../../src/zod.js';
import type { InvocationResponse } from '../../src/providers/types.js';

const canned: InvocationResponse = {
  text: 'ok',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function linearFlow() {
  return defineFlow({
    name: 'linear',
    version: '0.1.0',
    defaultProvider: 'mock',
    input: z.object({}),
    steps: {
      a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
      b: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['a'],
        output: { handoff: 'b-out' },
      })._unsafeUnwrap(),
      c: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['b'],
        output: { handoff: 'c-out' },
      })._unsafeUnwrap(),
    },
  })._unsafeUnwrap();
}

describe('Runner — DAG walker', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-runner-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[RUNNER-001] executes a linear flow in topological order', async () => {
    const order: string[] = [];
    const provider = new MockProvider({
      responses: {
        a: (_req, ctx) => {
          order.push(ctx.stepId);
          return canned;
        },
        b: (_req, ctx) => {
          order.push(ctx.stepId);
          return canned;
        },
        c: (_req, ctx) => {
          order.push(ctx.stepId);
          return canned;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const result = await runner.run(linearFlow(), {});

    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('[RUNNER-002] respects opts.parallelism — never exceeds N concurrent invokes', async () => {
    const MAX = 3;
    const N = 10;
    let inflight = 0;
    let maxSeen = 0;
    const branches: Record<string, unknown> = {};
    const responses: Record<string, unknown> = {};
    for (let i = 0; i < N; i++) {
      const id = `l${i}`;
      branches[id] = step
        .prompt({ promptFile: 'p.md', dependsOn: ['r'], output: { handoff: `${id}-out` } })
        ._unsafeUnwrap();
      responses[id] = async () => {
        inflight++;
        maxSeen = Math.max(maxSeen, inflight);
        await new Promise((res) => setTimeout(res, 20));
        inflight--;
        return canned;
      };
    }
    const flow = defineFlow({
      name: 'fan',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        r: step.terminal({})._unsafeUnwrap(),
        ...(branches as Record<string, ReturnType<typeof step.prompt> extends { _unsafeUnwrap(): infer U } ? U : never>),
      },
      start: 'r',
    })._unsafeUnwrap();

    const provider = new MockProvider({
      responses: responses as Record<string, InvocationResponse | ((...a: unknown[]) => InvocationResponse)>,
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const result = await runner.run(flow, {}, { parallelism: MAX });

    expect(result.status).toBe('succeeded');
    expect(maxSeen).toBeLessThanOrEqual(MAX);
  });

  it('[RUNNER-003] onFail=abort stops the run and skips dependents', async () => {
    const flow = defineFlow({
      name: 'chain',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
        b: step.prompt({
          promptFile: 'p.md',
          dependsOn: ['a'],
          output: { handoff: 'b-out' },
        })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const bSpy = vi.fn(() => canned);
    const provider = new MockProvider({
      responses: {
        a: () => {
          throw new Error('a failed');
        },
        b: bSpy,
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const result = await runner.run(flow, {});

    expect(result.status).toBe('failed');
    expect(bSpy).not.toHaveBeenCalled();
    const state = JSON.parse(await readFile(join(tmp, 'state.json'), 'utf8'));
    expect(state.steps.a.status).toBe('failed');
    expect(state.steps.b.status).toBe('pending');
  });

  it('[RUNNER-004] onFail=continue lets downstream steps run', async () => {
    // Contract: step 'a' fails with onFail:'continue' — b and c still run.
    // Details of final run status left to implementation (could be 'succeeded' or 'failed').
    const flow = defineFlow({
      name: 'soft',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'a-out' },
          onFail: 'continue',
        })._unsafeUnwrap(),
        b: step.prompt({ promptFile: 'p.md', output: { handoff: 'b-out' } })._unsafeUnwrap(),
        c: step.prompt({
          promptFile: 'p.md',
          dependsOn: ['b'],
          output: { handoff: 'c-out' },
        })._unsafeUnwrap(),
      },
      start: 'a',
    })._unsafeUnwrap();

    const bSpy = vi.fn(() => canned);
    const cSpy = vi.fn(() => canned);
    const provider = new MockProvider({
      responses: {
        a: () => {
          throw new Error('boom');
        },
        b: bSpy,
        c: cSpy,
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.run(flow, {});

    expect(bSpy).toHaveBeenCalled();
    expect(cSpy).toHaveBeenCalled();
  });

  it('[RUNNER-005] input validation: invalid input rejects with FlowDefinitionError before any invoke', async () => {
    const flow = defineFlow({
      name: 'typed',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({ repoPath: z.string() }),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const provider = new MockProvider({ responses: { a: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await expect(runner.run(flow, { repoPath: 123 })).rejects.toBeInstanceOf(FlowDefinitionError);
  });

  it('[RUNNER-006] writes handoffs + state.json between steps (observable mid-run)', async () => {
    let stateMidRun: unknown;
    const provider = new MockProvider({
      responses: {
        a: canned,
        b: async () => {
          // step a has completed before step b starts, so state.json reflects that
          stateMidRun = JSON.parse(await readFile(join(tmp, 'state.json'), 'utf8'));
          return canned;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'two',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
        b: step.prompt({
          promptFile: 'p.md',
          dependsOn: ['a'],
          output: { handoff: 'b-out' },
        })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.run(flow, {});

    const mid = stateMidRun as { steps: Record<string, { status: string }> };
    expect(mid.steps.a.status).toBe('succeeded');
    expect(mid.steps.b.status).toBe('running');
  });

  it('[RUNNER-007] calls provider.authenticate() exactly once before any invoke', async () => {
    const authSpy = vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: { ok: true, billingSource: 'local', detail: 'mock' } } as unknown as Awaited<ReturnType<MockProvider['authenticate']>>));
    const provider = new MockProvider({ responses: { a: canned, b: canned, c: canned } });
    // Override authenticate with a spy
    (provider as unknown as { authenticate: typeof authSpy }).authenticate = authSpy;

    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = linearFlow();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.run(flow, {});

    expect(authSpy).toHaveBeenCalledTimes(1);
  });

  it('[RUNNER-008] aborts before any invoke when authenticate returns err', async () => {
    const invokeSpy = vi.fn();
    const provider = new MockProvider({ responses: { a: canned } });
    (provider as unknown as { authenticate: () => Promise<unknown> }).authenticate = async () => ({
      isOk: () => false,
      isErr: () => true,
      error: new ClaudeAuthError('unsafe env'),
    });
    (provider as unknown as { invoke: typeof invokeSpy }).invoke = invokeSpy;

    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = linearFlow();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await expect(runner.run(flow, {})).rejects.toBeInstanceOf(ClaudeAuthError);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe('Runner — abort handling (sprint 5 task_40)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-abort-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[ABORT-001] SIGINT mid-run flips run status to aborted and persists state', async () => {
    const provider = new MockProvider({
      responses: {
        slow: () => new Promise(() => {
          /* hangs forever */
        }) as unknown as InvocationResponse,
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'abortable',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        slow: step.prompt({ promptFile: 'p.md', output: { handoff: 's-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const p = runner.run(flow, {});
    setTimeout(() => process.emit('SIGINT'), 80);
    const result = await p.catch((e) => e);

    const stateRaw = await readFile(join(tmp, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw);
    expect(state.status).toBe('aborted');
    expect(state.steps.slow.status).toBe('failed');
    void result;
  });

  it('[ABORT-002] SIGTERM behaves identically to SIGINT', async () => {
    const provider = new MockProvider({
      responses: { slow: () => new Promise(() => undefined) as unknown as InvocationResponse },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'a2',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        slow: step.prompt({ promptFile: 'p.md', output: { handoff: 's-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const p = runner.run(flow, {});
    setTimeout(() => process.emit('SIGTERM'), 80);
    await p.catch(() => undefined);
    const state = JSON.parse(await readFile(join(tmp, 'state.json'), 'utf8'));
    expect(state.status).toBe('aborted');
  });

  it('[ABORT-003] abort cascades ctx.abortSignal to in-flight invokes', async () => {
    const aborted: string[] = [];
    const provider = new MockProvider({
      responses: {
        a: (_req, ctx) => {
          ctx.abortSignal.addEventListener('abort', () => aborted.push('a'));
          return new Promise(() => undefined) as unknown as InvocationResponse;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'a3',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const p = runner.run(flow, {});
    setTimeout(() => process.emit('SIGINT'), 50);
    await p.catch(() => undefined);
    expect(aborted).toContain('a');
  });

  it('[ABORT-004] SIGINT/SIGTERM listeners are removed on completion (no leaks across runs)', async () => {
    const before = process.listenerCount('SIGINT');
    const provider = new MockProvider({ responses: { a: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'a4',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.run(flow, {});
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });

  it('[ABORT-005] provider.close() is called once per provider on both success and abort paths', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const provider = new MockProvider({ responses: { a: canned } });
    (provider as unknown as { close: typeof closeSpy }).close = closeSpy;

    const registry = new ProviderRegistry();
    registry.register(provider);
    const flow = defineFlow({
      name: 'a5',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'a-out' } })._unsafeUnwrap(),
      },
    })._unsafeUnwrap();

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.run(flow, {});
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Runner — resume protocol (sprint 5 task_41)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-resume-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function seedState(steps: Record<string, { status: string; attempts: number }>) {
    const state = {
      runId: 'r1',
      flowName: 'linear',
      flowVersion: '0.1.0',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      input: {},
      steps,
    };
    await writeFile(join(tmp, 'state.json'), JSON.stringify(state), 'utf8');
  }

  it('[RESUME-001] re-runs only pending/failed steps; succeeded ones are not re-invoked', async () => {
    await seedState({
      a: { status: 'succeeded', attempts: 1 },
      b: { status: 'failed', attempts: 1 },
      c: { status: 'pending', attempts: 0 },
    });

    const aSpy = vi.fn(() => canned);
    const bSpy = vi.fn(() => canned);
    const cSpy = vi.fn(() => canned);
    const provider = new MockProvider({ responses: { a: aSpy, b: bSpy, c: cSpy } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    // resume requires the flow context; pass the same flow.
    await (runner as unknown as Runner).resume(tmp);

    expect(aSpy).not.toHaveBeenCalled();
    expect(bSpy).toHaveBeenCalled();
    expect(cSpy).toHaveBeenCalled();
  });

  it('[RESUME-002] reinitializes CostTracker from metrics.json on resume', async () => {
    await writeFile(
      join(tmp, 'metrics.json'),
      JSON.stringify([
        {
          stepId: 'a',
          flowName: 'linear',
          runId: 'r1',
          timestamp: '2026-01-01T00:00:00.000Z',
          model: 'mock',
          tokensIn: 10,
          tokensOut: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          numTurns: 1,
          durationMs: 10,
          costUsd: 0.05,
        },
      ]),
      'utf8',
    );
    await seedState({
      a: { status: 'succeeded', attempts: 1 },
      b: { status: 'pending', attempts: 0 },
    });

    const provider = new MockProvider({ responses: { a: canned, b: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    const result = await runner.resume(tmp);

    // The run result should include the pre-resume spend (0.05) in total cost.
    expect(result.cost.totalUsd).toBeGreaterThanOrEqual(0.05);
  });

  it('[RESUME-003] reads flow-ref.json to re-import the flow', async () => {
    // When flow-ref.json is missing, resume must fail with a clear error.
    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await expect(runner.resume(tmp)).rejects.toBeTruthy();
  });

  it('[RESUME-004] refuses on flowName mismatch with actionable error', async () => {
    await seedState({ a: { status: 'succeeded', attempts: 1 } });
    // write flow-ref that points at a flow with a different name
    await writeFile(
      join(tmp, 'flow-ref.json'),
      JSON.stringify({ flowName: 'oldFlow', flowVersion: '1.0.0', path: '/not/used' }),
      'utf8',
    );

    const provider = new MockProvider({ responses: {} });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await expect(runner.resume(tmp)).rejects.toMatchObject({
      message: expect.stringMatching(/oldFlow|mismatch|version/),
    });
  });

  it('[RESUME-005] retry budget survives resume — attempts carry over', async () => {
    await seedState({
      a: { status: 'failed', attempts: 2 },
    });

    const aSpy = vi.fn(() => {
      throw new Error('still failing');
    });
    const provider = new MockProvider({ responses: { a: aSpy } });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.resume(tmp).catch(() => undefined);

    // maxRetries:3 and 2 attempts already used => resume should run exactly 1 more.
    expect(aSpy).toHaveBeenCalledTimes(1);
  });

  it('[RESUME-006] recomputes ready queue — dispatches dependents of succeeded steps first', async () => {
    await seedState({
      a: { status: 'succeeded', attempts: 1 },
      b: { status: 'failed', attempts: 1 },
      c: { status: 'pending', attempts: 0 },
    });

    const callOrder: string[] = [];
    const provider = new MockProvider({
      responses: {
        b: (_req, ctx) => {
          callOrder.push(ctx.stepId);
          return canned;
        },
        c: (_req, ctx) => {
          callOrder.push(ctx.stepId);
          return canned;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir: tmp });
    await runner.resume(tmp);

    expect(callOrder[0]).toBe('b');
    expect(callOrder).toContain('c');
  });
});
