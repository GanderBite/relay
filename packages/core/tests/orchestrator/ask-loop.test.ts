/**
 * Orchestrator-level tests for ask steps inside loop bodies. Cover three
 * scenarios:
 *
 * 1. State shape after a loop body ask step pauses (first pass).
 * 2. Mid-iteration resume: non-ask body steps that succeeded on a prior
 *    pass are short-circuited and not re-invoked.
 * 3. Two-iteration round-trip: each iteration pauses on the ask step and
 *    resumes via iteration-scoped answer files; the implement body step
 *    runs at most once per fresh iteration.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { askIterationAnswerHandoffPath } from '../../src/orchestrator/exec/ask.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type {
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
} from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { atomicWriteJson } from '../../src/util/atomic-write.js';
import { z } from '../../src/zod.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ASK_LOOP_FIXTURE = join(HERE, 'fixtures', 'ask-loop-flow.ts');
const FIXTURES_DIR = join(HERE, 'fixtures');

// Canned implement response that returns { done: false } — loop continues.
const IMPL_CONTINUE: InvocationResponse = {
  text: '{"done":false}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

// ---------------------------------------------------------------------------
// Flow factory — mirrors ask-loop-flow.ts fixture
// ---------------------------------------------------------------------------

function makeAskLoopFlow() {
  return defineFlow({
    name: 'ask-loop-flow',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      fix_loop: step.loop({
        body: {
          implement: step.prompt({
            promptFile: 'p.md',
            output: { handoff: 'implementation' },
          }),
          feedback: step.ask({
            questions: [{ id: 'comment', kind: 'text', label: 'Any feedback?' }],
            dependsOn: ['implement'],
          }),
        },
        until: { from: 'implementation', when: { done: true } },
        maxIterations: 3,
      }),
    },
  });
}

function makeRegistry(
  responses: Record<
    string,
    InvocationResponse | ((req: InvocationRequest, ctx: InvocationContext) => InvocationResponse)
  >,
) {
  const provider = new MockProvider({ responses });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

interface PersistedRunState {
  status: string;
  steps: Record<string, { status: string; handoffs?: string[]; iter?: number }>;
  awaitingInput?:
    | {
        stepId: string;
        questions: unknown[];
        loopStepId?: string;
        loopIter?: number;
      }
    | undefined;
}

async function readState(runDir: string): Promise<PersistedRunState> {
  const raw = await readFile(join(runDir, 'state.json'), 'utf8');
  return JSON.parse(raw) as PersistedRunState;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator — ask step inside loop body', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-loop-'));
    // The prompt executor reads the promptFile from flowDir.
    await writeFile(join(FIXTURES_DIR, 'p.md'), '# test prompt', 'utf8');
    await mkdir(join(tmp, 'live'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: state.json shape after pause
  // -------------------------------------------------------------------------

  it('loop body ask: state.json shape after pause at iter 1 feedback step', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ implement: IMPL_CONTINUE }),
      runDir: tmp,
    });

    const result = await orchestrator.run(
      makeAskLoopFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
      },
    );

    // The run should pause because the loop body ask step requests input.
    expect(result.status).toBe('paused');

    // Read the raw state.json and assert its shape.
    const state = await readState(tmp);

    expect(state.status).toBe('paused');

    // The synthesised body-step key for the feedback ask step.
    const feedbackKey = 'fix_loop::feedback';
    expect(state.steps[feedbackKey]?.status).toBe('paused');

    // awaitingInput must name the feedback body step and carry loop context.
    expect(state.awaitingInput?.stepId).toBe(feedbackKey);
    expect(state.awaitingInput?.loopStepId).toBe('fix_loop');
    expect(state.awaitingInput?.loopIter).toBe(1);
    expect(Array.isArray(state.awaitingInput?.questions)).toBe(true);
    expect(state.awaitingInput?.questions).toHaveLength(1);

    // The answer file must NOT exist yet — no answer has been written.
    const answerPath = askIterationAnswerHandoffPath(tmp, 'fix_loop', 1, 'feedback');
    await expect(readFile(answerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // -------------------------------------------------------------------------
  // Test 2: mid-iteration resume short-circuits already-succeeded body steps
  // -------------------------------------------------------------------------

  it('loop body ask: resume re-enters at the paused iteration and resolves the answer, then exits', async () => {
    // Every body-step kind gets a synthesised state entry keyed by
    // `<loopStepId>::<bodyStepId>`, so non-ask body steps that succeeded on
    // a prior pass do not re-run on resume — the loop's skip path reads the
    // iteration-scoped handoff written on the original pass. This test
    // verifies that resume correctly:
    // 1. SKIPS the already-succeeded implement body step (no extra invocation).
    // 2. Resolves the feedback ask step from the answer file.
    // 3. Exits the loop when the until condition matches against the latest
    //    pointer that the prior pass promoted.
    let implementCallCount = 0;
    const implementSpy = vi.fn(
      (_req: InvocationRequest, _ctx: InvocationContext): InvocationResponse => {
        implementCallCount += 1;
        // implement returns {done:true} on its only call (first run, iter 1)
        // so the latest implementation handoff already encodes the loop-exit
        // condition. After resume, the until check at iter 1 reads that
        // pointer and matches, so the loop exits without a second iteration.
        return {
          text: JSON.stringify({ done: true }),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
          costUsd: 0,
          durationMs: 1,
          numTurns: 1,
          model: 'mock',
          stopReason: 'end_turn',
        };
      },
    );

    const orchestrator = createOrchestrator({
      providers: makeRegistry({ implement: implementSpy }),
      runDir: tmp,
    });

    // First pass: implement runs once and writes {done:true}. feedback then
    // pauses for the iter 1 answer.
    const firstResult = await orchestrator.run(
      makeAskLoopFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
        flowPath: ASK_LOOP_FIXTURE,
      },
    );
    expect(firstResult.status).toBe('paused');
    expect(implementCallCount).toBe(1);

    // Write the answer file at the iteration-scoped path.
    const answerPath = askIterationAnswerHandoffPath(tmp, 'fix_loop', 1, 'feedback');
    const writeResult = await atomicWriteJson(answerPath, { comment: 'looks good' });
    expect(writeResult.isOk()).toBe(true);

    // Resume: implement is short-circuited (state entry succeeded @ iter 1),
    // feedback resolves from the answer file, until condition matches the
    // promoted latest pointer ({done:true}), loop exits → run succeeds.
    // implementCallCount stays at 1 — the body step is not re-invoked.
    const resumeResult = await orchestrator.resume(tmp, {
      ...RUN_OPTS,
      flowDir: FIXTURES_DIR,
    });

    expect(resumeResult.status).toBe('succeeded');
    expect(implementCallCount).toBe(1);

    const state = await readState(tmp);
    expect(state.status).toBe('succeeded');
  });

  // -------------------------------------------------------------------------
  // Test 3: two-iteration round-trip
  // -------------------------------------------------------------------------

  it('loop body ask: two-iteration round-trip — each iteration pauses then resumes', async () => {
    // Non-ask body steps that succeeded on a prior pass do not re-run on
    // resume — the synthesised state entry's succeeded status short-circuits
    // the dispatch and the loop reads the iteration-scoped handoff written
    // on the original pass. With two iterations the implement call sequence
    // is therefore one call per fresh iteration, not one per pause:
    //
    //   call 1: first run, iter 1                → {done:false} → feedback pauses
    //   (resume 1: iter 1 implement skipped, feedback resolves, until fails, iter 2 begins)
    //   call 2: first resume, iter 2 (new iter)  → {done:true}  → feedback pauses
    //   (resume 2: iter 2 implement skipped, feedback resolves, until matches, done)
    //
    // A response queue (array.shift()) encodes this sequence without relying on
    // the call counter exceeding a threshold.
    const implementResponses = [false, true];
    let implementCallCount = 0;

    const orchestrator = createOrchestrator({
      providers: makeRegistry({
        implement: (_req: InvocationRequest, _ctx: InvocationContext): InvocationResponse => {
          implementCallCount += 1;
          const done = implementResponses.shift() ?? false;
          return {
            text: JSON.stringify({ done }),
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
            costUsd: 0,
            durationMs: 1,
            numTurns: 1,
            model: 'mock',
            stopReason: 'end_turn',
          };
        },
      }),
      runDir: tmp,
    });

    // ---- First run: pauses at iter 1 feedback ----

    const firstResult = await orchestrator.run(
      makeAskLoopFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: FIXTURES_DIR,
        flowPath: ASK_LOOP_FIXTURE,
      },
    );

    expect(firstResult.status).toBe('paused');
    // implement called once (first run, iter 1, returns false).
    expect(implementCallCount).toBe(1);

    // Verify iter 1 pause shape.
    const stateAfterFirstPause = await readState(tmp);
    expect(stateAfterFirstPause.status).toBe('paused');
    expect(stateAfterFirstPause.awaitingInput?.loopStepId).toBe('fix_loop');
    expect(stateAfterFirstPause.awaitingInput?.loopIter).toBe(1);

    // Iter 1 answer path must not exist yet.
    const iter1AnswerPath = askIterationAnswerHandoffPath(tmp, 'fix_loop', 1, 'feedback');
    await expect(readFile(iter1AnswerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // Write iter 1 answer via the iteration-scoped path.
    const writeIter1 = await atomicWriteJson(iter1AnswerPath, {
      comment: 'first iteration feedback',
    });
    expect(writeIter1.isOk()).toBe(true);

    // ---- First resume: iter 1 implement is skipped (succeeded on first
    //      run), feedback resolves from iter_1 answer, until check fails
    //      (latest=false), iter 2 begins, implement runs (returns true),
    //      feedback pauses at iter 2 ----

    const secondResult = await orchestrator.resume(tmp, {
      ...RUN_OPTS,
      flowDir: FIXTURES_DIR,
    });

    expect(secondResult.status).toBe('paused');
    // implement called once more on this resume (iter 2 fresh dispatch). The
    // iter 1 invocation is skipped because the synthesised state entry shows
    // it already succeeded on the first run.
    expect(implementCallCount).toBe(2);

    // Verify iter 2 pause shape.
    const stateAfterSecondPause = await readState(tmp);
    expect(stateAfterSecondPause.status).toBe('paused');
    expect(stateAfterSecondPause.awaitingInput?.loopStepId).toBe('fix_loop');
    expect(stateAfterSecondPause.awaitingInput?.loopIter).toBe(2);

    // Iter 2 answer path must not exist yet.
    const iter2AnswerPath = askIterationAnswerHandoffPath(tmp, 'fix_loop', 2, 'feedback');
    await expect(readFile(iter2AnswerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // Write iter 2 answer via the iteration-scoped path.
    const writeIter2 = await atomicWriteJson(iter2AnswerPath, {
      comment: 'second iteration feedback',
    });
    expect(writeIter2.isOk()).toBe(true);

    // ---- Second resume: iter 2 implement is skipped (succeeded on first
    //      resume with done:true), feedback resolves from iter_2 answer,
    //      until matches the promoted latest pointer, loop exits → run
    //      succeeds ----

    const finalResult = await orchestrator.resume(tmp, {
      ...RUN_OPTS,
      flowDir: FIXTURES_DIR,
    });

    expect(finalResult.status).toBe('succeeded');
    // implement is NOT re-invoked on the second resume — the iter 2 entry
    // is already succeeded, so the count stays at 2.
    expect(implementCallCount).toBe(2);

    const finalState = await readState(tmp);
    expect(finalState.status).toBe('succeeded');

    // Both iteration answer paths exist on disk.
    const iter1Content = JSON.parse(await readFile(iter1AnswerPath, 'utf8'));
    expect(iter1Content).toEqual({ comment: 'first iteration feedback' });
    const iter2Content = JSON.parse(await readFile(iter2AnswerPath, 'utf8'));
    expect(iter2Content).toEqual({ comment: 'second iteration feedback' });
  });
});
