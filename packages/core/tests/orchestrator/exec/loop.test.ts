import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHandoffValues } from '../../../src/context-inject.js';
import { CostTracker } from '../../../src/cost.js';
import { FlowDefinitionError, LoopMaxIterationsError } from '../../../src/errors.js';
import { defineFlow } from '../../../src/flow/define.js';
import { buildGraph } from '../../../src/flow/graph.js';
import { step } from '../../../src/flow/step.js';
import type { LoopStepSpec, Step } from '../../../src/flow/types.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import type { LoopExecutorContext } from '../../../src/orchestrator/exec/loop.js';
import { executeLoop } from '../../../src/orchestrator/exec/loop.js';
import type { PromptStepResult } from '../../../src/orchestrator/exec/prompt.js';
import { MockProvider } from '../../../src/testing/mock-provider.js';
import { z } from '../../../src/zod.js';

function mkPromptResult(stepId: string, handoffs: string[]): PromptStepResult {
  return {
    kind: 'prompt',
    stepId,
    text: '{}',
    handoffs,
    artifacts: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    model: 'mock',
  };
}

/**
 * Build a minimal compiled LoopStepSpec with a bodyGraph attached.
 * The body must be fully compiled (Step objects with id set) before calling
 * this helper because buildGraph expects a step map whose ids match the keys.
 */
function buildLoopSpec(opts: {
  id: string;
  body: Record<string, Step>;
  untilFrom: string;
  untilWhen: Record<string, unknown>;
  maxIterations: number;
  dependsOn?: string[];
  contextFrom?: string[];
}): LoopStepSpec {
  const bodyGraphResult = buildGraph(opts.body);
  if (bodyGraphResult.isErr()) {
    throw bodyGraphResult.error;
  }
  return {
    id: opts.id,
    kind: 'loop',
    body: opts.body,
    until: { from: opts.untilFrom, when: opts.untilWhen },
    maxIterations: opts.maxIterations,
    bodyGraph: bodyGraphResult.value,
    ...(opts.dependsOn !== undefined ? { dependsOn: opts.dependsOn } : {}),
    ...(opts.contextFrom !== undefined ? { contextFrom: opts.contextFrom } : {}),
  };
}

/** Build a compiled prompt-shaped body Step with a handoff output. */
function promptBodyStep(id: string, handoff: string, dependsOn?: string[]): Step {
  return {
    id,
    kind: 'prompt',
    promptFile: 'p.md',
    output: { handoff },
    ...(dependsOn !== undefined ? { dependsOn } : {}),
  };
}

describe('executeLoop', () => {
  let tmp: string;
  let handoffStore: HandoffStore;
  let costTracker: CostTracker;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-loop-'));
    await mkdir(join(tmp, 'live'), { recursive: true });
    handoffStore = new HandoffStore(tmp);
    costTracker = new CostTracker(join(tmp, 'metrics.json'));
    logger = createLogger({ flowName: 'test-flow', runId: 'r1' });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeCtx(overrides?: Partial<LoopExecutorContext>): LoopExecutorContext {
    const provider = new MockProvider({ responses: {} });
    return {
      runDir: tmp,
      runId: 'r1',
      flowDir: tmp,
      flowName: 'test-flow',
      stepId: 'fix_loop',
      attempt: 1,
      abortSignal: new AbortController().signal,
      handoffStore,
      costTracker,
      stateMachine: undefined as unknown as LoopExecutorContext['stateMachine'],
      logger,
      provider,
      providers: undefined as unknown as LoopExecutorContext['providers'],
      dispatch: async () => {
        throw new Error('dispatch not configured');
      },
      ...overrides,
    };
  }

  it('[LOOP-001] loop succeeds when until matches on iteration 1', async () => {
    const implementStep = promptBodyStep('implement', 'implementation');
    const reviewStep = promptBodyStep('review', 'review', ['implement']);
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { implement: implementStep, review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 5,
    });

    // Tracks which body steps were dispatched per iteration.
    const dispatched: Array<{ id: string; iter: number }> = [];

    const ctx = makeCtx({
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        dispatched.push({ id: bodyStepId, iter: loopIter });
        if (bodyStepId === 'implement') {
          const writeResult = await handoffStore.write('implementation', {
            code: 'console.log("hi")',
          });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('implement', ['implementation']);
        }
        if (bodyStepId === 'review') {
          const writeResult = await handoffStore.write('review', {
            decision: 'done',
            confidence: 'high',
          });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, ctx);

    expect(result.kind).toBe('loop');
    expect(result.iterations).toBe(1);
    expect(result.loopStepId).toBe('fix_loop');

    // Both body steps were dispatched once at iter 1.
    expect(dispatched.filter((d) => d.iter === 1).map((d) => d.id)).toEqual([
      'implement',
      'review',
    ]);

    // Verify iter_1 subdirectory exists.
    const iterDir = join(tmp, 'handoffs', 'fix_loop', 'iter_1');
    const dirStat = await stat(iterDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Verify iteration-scoped files exist.
    const implementIterFile = join(iterDir, 'implementation.json');
    const reviewIterFile = join(iterDir, 'review.json');
    await expect(stat(implementIterFile)).resolves.toBeTruthy();
    await expect(stat(reviewIterFile)).resolves.toBeTruthy();

    // Verify latest-pointer files exist.
    const latestDir = join(tmp, 'handoffs', 'fix_loop');
    await expect(stat(join(latestDir, 'review.json'))).resolves.toBeTruthy();
  });

  it('[LOOP-002] loop succeeds when until matches on iteration 3', async () => {
    const implementStep = promptBodyStep('implement', 'implementation');
    const reviewStep = promptBodyStep('review', 'review', ['implement']);
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { implement: implementStep, review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 5,
    });

    let callCount = 0;
    const ctx = makeCtx({
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'implement') {
          const writeResult = await handoffStore.write('implementation', { code: `v${loopIter}` });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('implement', ['implementation']);
        }
        if (bodyStepId === 'review') {
          callCount += 1;
          // Continue for iters 1-2, done for iter 3.
          const decision = loopIter <= 2 ? 'continue' : 'done';
          const writeResult = await handoffStore.write('review', { decision });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, ctx);

    expect(result.kind).toBe('loop');
    expect(result.iterations).toBe(3);

    // Verify iter_1/, iter_2/, iter_3/ all exist.
    for (const i of [1, 2, 3]) {
      const iterDir = join(tmp, 'handoffs', 'fix_loop', `iter_${i}`);
      const dirStat = await stat(iterDir);
      expect(dirStat.isDirectory(), `iter_${i}/ must exist`).toBe(true);
    }

    // review dispatch was called 3 times (once per iteration).
    expect(callCount).toBe(3);
  });

  it('[LOOP-003] loop throws LoopMaxIterationsError when until never matches', async () => {
    const reviewStep = promptBodyStep('review', 'review');
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 2,
    });

    const ctx = makeCtx({
      dispatch: async (bodyStepId) => {
        if (bodyStepId === 'review') {
          const writeResult = await handoffStore.write('review', { decision: 'continue' });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    let caught: unknown;
    try {
      await executeLoop(loopSpec, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LoopMaxIterationsError);
    const err = caught as LoopMaxIterationsError;
    expect(err.iterationsRun).toBe(2);
    expect(err.maxIterations).toBe(2);
    expect(err.loopStepId).toBe('fix_loop');
    expect(err.details?.iterationsRun).toBe(2);
  });

  it('[LOOP-004] optional contextFrom — review? resolves to absent on iter 1, present on iter 2', async () => {
    // This test verifies that loadHandoffValues correctly handles the optional
    // ref 'review?' — absent on iter 1, present after iter 1 writes it.
    // The dispatch closure simulates what executePrompt does: it checks the
    // store via loadHandoffValues with 'review?' before invoking the provider.
    // On iter 1 the review handoff does not exist yet; on iter 2 it does.
    //
    // The step specs used here do not carry contextFrom in their compiled form
    // because building the body graph in non-body mode rejects optional refs
    // to non-ancestor producers. The optional-ref semantics are tested at the
    // loadHandoffValues level (which is what executePrompt calls).

    const implementStep = promptBodyStep('implement', 'implementation');
    const reviewStep = promptBodyStep('review', 'review', ['implement']);

    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { implement: implementStep, review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 5,
    });

    const promptsReceivedContext: Array<{
      iter: number;
      hasReview: boolean;
      reviewValue: unknown;
    }> = [];

    const ctx = makeCtx({
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'implement') {
          const loadResult = await loadHandoffValues(handoffStore, ['review?']);
          expect(loadResult.isOk()).toBe(true);
          const loaded = loadResult._unsafeUnwrap();
          const reviewValue = loaded.review;
          const reviewExists = reviewValue !== null && reviewValue !== undefined;
          promptsReceivedContext.push({ iter: loopIter, hasReview: reviewExists, reviewValue });

          const writeResult = await handoffStore.write('implementation', { code: `v${loopIter}` });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('implement', ['implementation']);
        }
        if (bodyStepId === 'review') {
          const decision = loopIter >= 2 ? 'done' : 'continue';
          const writeResult = await handoffStore.write('review', { decision, iter: loopIter });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, ctx);
    expect(result.iterations).toBe(2);

    // On iter 1, review handoff does not exist yet — loadHandoffValues must
    // resolve 'review?' to null, not an error.
    const iter1 = promptsReceivedContext.find((r) => r.iter === 1);
    expect(iter1?.hasReview, 'review must be absent on iter 1').toBe(false);
    expect(iter1?.reviewValue, 'review value must be null on iter 1 (optional absent)').toBeNull();

    // On iter 2, review handoff from iter 1 is present in the store.
    const iter2 = promptsReceivedContext.find((r) => r.iter === 2);
    expect(iter2?.hasReview, 'review must be present on iter 2 (written by iter 1)').toBe(true);
    expect(iter2?.reviewValue).not.toBeNull();
  });

  it('[LOOP-005] body cycle detection — body with a cycle is rejected at defineFlow time', () => {
    // The loop builder calls buildBodyGraph, which runs the same cycle detection
    // as buildGraph. A cycle in the body should produce a FlowDefinitionError.
    expect(() => {
      defineFlow({
        name: 'fix-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              implement: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'implementation' },
                dependsOn: ['review'],
              }),
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
                dependsOn: ['implement'],
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
        },
      });
    }).toThrow(FlowDefinitionError);

    let caught: unknown;
    try {
      defineFlow({
        name: 'fix-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              implement: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'implementation' },
                dependsOn: ['review'],
              }),
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
                dependsOn: ['implement'],
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowDefinitionError);
    expect((caught as FlowDefinitionError).message).toMatch(/cycle/i);
  });

  it('[LOOP-006] nested loops rejected at builder call time', () => {
    expect(() => {
      step.loop({
        body: {
          // Inline nested loop — the body builder rejects this synchronously.
          inner_loop: step.loop({
            body: {
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 3,
          }),
        },
        until: { from: 'review', when: { decision: 'done' } },
        maxIterations: 5,
      });
    }).toThrow(FlowDefinitionError);

    let caught: unknown;
    try {
      step.loop({
        body: {
          inner_loop: step.loop({
            body: {
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 3,
          }),
        },
        until: { from: 'review', when: { decision: 'done' } },
        maxIterations: 5,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowDefinitionError);
  });

  it('[LOOP-007] body referencing unknown handoff without "?" is rejected at defineFlow time', () => {
    // 'review' depends on 'ghostHandoff' contextFrom which no body step produces.
    // buildGraph (body mode) should reject this.
    expect(() => {
      defineFlow({
        name: 'fix-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              implement: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'implementation' },
              }),
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
                dependsOn: ['implement'],
                contextFrom: ['ghostHandoff'],
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
        },
      });
    }).toThrow(FlowDefinitionError);
  });

  it('[LOOP-008] downstream step contextFrom "fix_loop.review" reads final iteration handoff', async () => {
    // Test that after the loop completes, the latest-pointer at
    // handoffs/fix_loop/review.json holds the final iteration's value, and
    // loadHandoffValues resolves it via the "fix_loop.review" dotted id.

    const implementStep = promptBodyStep('implement', 'implementation');
    const reviewStep = promptBodyStep('review', 'review', ['implement']);
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { implement: implementStep, review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 5,
    });

    const ctx = makeCtx({
      stepId: 'fix_loop',
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'implement') {
          const writeResult = await handoffStore.write('implementation', { code: `v${loopIter}` });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('implement', ['implementation']);
        }
        if (bodyStepId === 'review') {
          const decision = loopIter >= 3 ? 'done' : 'continue';
          const writeResult = await handoffStore.write('review', {
            decision,
            revision: loopIter,
          });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, ctx);
    expect(result.iterations).toBe(3);

    // Simulate a downstream step reading 'fix_loop.review' via loadHandoffValues.
    const loadResult = await loadHandoffValues(handoffStore, ['fix_loop.review']);
    expect(loadResult.isOk()).toBe(true);
    const values = loadResult._unsafeUnwrap();

    // The latest-pointer must contain the final iteration's review value.
    const reviewValue = values['fix_loop.review'] as Record<string, unknown>;
    expect(reviewValue.decision).toBe('done');
    expect(reviewValue.revision).toBe(3);
  });

  it('[LOOP-009] resume after mid-loop crash re-runs from iteration 1', async () => {
    // The loop executor always starts from iter 1 — no per-iteration state is
    // persisted. A second executeLoop call over the same run dir represents a
    // resume and must re-invoke body steps from the beginning.

    const reviewStep = promptBodyStep('review', 'review');
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done' },
      maxIterations: 10,
    });

    // --- First run: abort after iter 1 body completes but before until check. ---
    const abortCtrl = new AbortController();
    const firstRunIters: number[] = [];
    let firstRunDispatchCount = 0;

    const firstCtx = makeCtx({
      abortSignal: abortCtrl.signal,
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'review') {
          firstRunIters.push(loopIter);
          firstRunDispatchCount += 1;
          // Abort after the first dispatch so the loop is interrupted
          // before the until condition is checked.
          if (loopIter === 1) {
            // Write continue so if the loop got to check it would not exit.
            const writeResult = await handoffStore.write('review', { decision: 'continue' });
            if (writeResult.isErr()) throw writeResult.error;
            // Abort immediately after writing.
            abortCtrl.abort();
          }
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    // First run should throw AbortError because we aborted.
    let firstRunError: unknown;
    try {
      await executeLoop(loopSpec, firstCtx);
    } catch (e) {
      firstRunError = e;
    }
    expect((firstRunError as Error).name).toBe('AbortError');
    expect(firstRunDispatchCount).toBeGreaterThanOrEqual(1);

    // --- Second run (resume): new AbortController, fresh iteration from 1. ---
    const secondRunIters: number[] = [];
    let secondRunDispatchCount = 0;

    const secondCtx = makeCtx({
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'review') {
          secondRunIters.push(loopIter);
          secondRunDispatchCount += 1;
          // Done on iter 3 to give us a visible multi-iteration run.
          const decision = loopIter >= 3 ? 'done' : 'continue';
          const writeResult = await handoffStore.write('review', { decision });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, secondCtx);

    // Resume must re-start from iter 1, not from iter 2.
    expect(secondRunIters[0]).toBe(1);
    // The run must complete with the expected iterations count.
    expect(result.iterations).toBe(3);
    // Body steps invoked at least 3 times on the second run (iters 1, 2, 3).
    expect(secondRunDispatchCount).toBeGreaterThanOrEqual(3);
  });

  it('[LOOP-010] until.when deep-equal — partial match does not terminate', async () => {
    // until.when requires ALL keys to match. A response with the correct
    // `decision` but wrong `confidence` must not satisfy the condition.

    const reviewStep = promptBodyStep('review', 'review');
    const loopSpec = buildLoopSpec({
      id: 'fix_loop',
      body: { review: reviewStep },
      untilFrom: 'review',
      untilWhen: { decision: 'done', confidence: 'high' },
      maxIterations: 10,
    });

    let callCount = 0;
    const ctx = makeCtx({
      dispatch: async (bodyStepId, _bodyStep, loopIter) => {
        if (bodyStepId === 'review') {
          callCount += 1;
          // Iters 1 and 2: correct decision, wrong confidence.
          // Iter 3: both match.
          const confidence = loopIter <= 2 ? 'low' : 'high';
          const writeResult = await handoffStore.write('review', {
            decision: 'done',
            confidence,
          });
          if (writeResult.isErr()) throw writeResult.error;
          return mkPromptResult('review', ['review']);
        }
        throw new Error(`unexpected bodyStepId: ${bodyStepId}`);
      },
    });

    const result = await executeLoop(loopSpec, ctx);

    // The loop must run 3 full iterations — partial match on iters 1 and 2
    // must NOT terminate the loop.
    expect(result.iterations).toBe(3);
    expect(callCount).toBe(3);
  });
});
