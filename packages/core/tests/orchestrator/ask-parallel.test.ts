/**
 * Orchestrator-level tests for an ask step inside a parallel branch.
 *
 * Two suites cover the parallel branch ask scenario:
 *
 * 1. 'ask in parallel branch: sibling completes before pause' — the parallel
 *    step fans out to an ask branch and a prompt branch. The ask branch fires
 *    AwaitingInputSignal, pausing the run. The prompt branch either completes
 *    before the pause (status 'succeeded') or is swept to 'pending' depending
 *    on timing, but in either case the state is clean (not 'running'). On
 *    resume after writing the answer file, all steps succeed.
 *
 * 2. 'ask in parallel branch: sibling aborted mid-flight' — the prompt branch
 *    is given an explicit delay so it is definitely still in-flight (status
 *    'running') when the ask pause fires. The sibling sweep (failStep →
 *    resetStep) must flip it to 'pending'. After pause: promptBranch status
 *    is 'pending', NOT 'running'. On resume: prompt branch re-runs and the
 *    overall flow succeeds.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { askAnswerHandoffPath } from '../../src/orchestrator/exec/ask.js';
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
const ASK_PARALLEL_FLOW_FIXTURE = join(HERE, 'fixtures', 'ask-parallel-flow.ts');

const canned: InvocationResponse = {
  text: '{"ok":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

const ASK_QUESTION = { id: 'answer', kind: 'text' as const, label: 'Your answer?' };

interface PersistedRunState {
  status: string;
  steps: Record<string, { status: string; handoffs?: string[]; attempts?: number }>;
  awaitingInput?: { stepId: string; questions: unknown[] } | undefined;
}

function makeRegistry(
  responses: Record<
    string,
    | InvocationResponse
    | ((
        req: InvocationRequest,
        ctx: InvocationContext,
      ) => InvocationResponse | Promise<InvocationResponse>)
  >,
) {
  const provider = new MockProvider({ responses });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

/**
 * Flow with two branches under a barrier: askBranch (ask step) and
 * promptBranch (prompt step). conclude runs after the barrier succeeds.
 * Only one ask step in the entire flow (DAG validator rejects two concurrent asks).
 */
function makeAskParallelFlow() {
  return defineFlow({
    name: 'ask-parallel-flow',
    version: '0.0.1',
    input: z.object({}),
    steps: {
      barrier: step.parallel({
        branches: ['askBranch', 'promptBranch'],
      }),
      askBranch: step.ask({
        questions: [ASK_QUESTION],
      }),
      promptBranch: step.prompt({
        promptFile: 'p.md',
        output: { handoff: 'prompt-out' },
      }),
      conclude: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['barrier'],
        output: { handoff: 'conclude-out' },
      }),
    },
  });
}

async function readState(runDir: string): Promise<PersistedRunState> {
  const raw = await readFile(join(runDir, 'state.json'), 'utf8');
  return JSON.parse(raw) as PersistedRunState;
}

// ---------------------------------------------------------------------------
// Suite 1: ask in parallel branch — sibling completes before pause
// ---------------------------------------------------------------------------
//
// The ask step (ENOENT path) fires its AwaitingInputSignal quickly. Depending
// on OS scheduling and disk cache state, the prompt branch may reach
// 'succeeded' before the sibling sweep runs, or it may still be 'running' and
// get swept to 'pending'. Either terminal state is acceptable here — what
// matters is:
//   a) The run's overall status is 'paused'.
//   b) The askBranch is 'paused'.
//   c) No step is left at status 'running' (the snapshot is always clean).
//   d) Resume after writing the answer file succeeds overall.
//
// The separate 'sibling aborted mid-flight' suite (below) locks in the 'pending'
// sweep behavior with an explicit delay.

describe('ask in parallel branch: sibling completes before pause', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-parallel-fast-'));
    await writeFile(join(tmp, 'p.md'), '# test prompt', 'utf8');
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('first run returns status:paused and pausedStepId:askBranch', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ promptBranch: canned, conclude: canned }),
      runDir: tmp,
    });

    const result = await orchestrator.run(makeAskParallelFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    expect(result.status).toBe('paused');
    expect(result.pausedStepId).toBe('askBranch');
  });

  it('state.json after first run: overall paused, askBranch paused, no step left running', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ promptBranch: canned, conclude: canned }),
      runDir: tmp,
    });

    await orchestrator.run(makeAskParallelFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('paused');
    expect(state.steps['askBranch']?.status).toBe('paused');
    expect(state.awaitingInput?.stepId).toBe('askBranch');
    // The sibling sweep guarantees no step is left in 'running' status after pause.
    for (const [stepId, step] of Object.entries(state.steps)) {
      expect(step.status, `step "${stepId}" must not be left running after pause`).not.toBe(
        'running',
      );
    }
    // promptBranch is either 'succeeded' (completed before pause) or 'pending'
    // (swept from 'running' by the sibling sweep). Neither is 'running'.
    const promptStatus = state.steps['promptBranch']?.status;
    expect(['succeeded', 'pending']).toContain(promptStatus);
  });

  it('resume after writing answer: overall status succeeded, all steps succeeded', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ promptBranch: canned, conclude: canned }),
      runDir: tmp,
    });

    const firstResult = await orchestrator.run(
      makeAskParallelFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_PARALLEL_FLOW_FIXTURE,
      },
    );
    expect(firstResult.status).toBe('paused');

    const answerPath = askAnswerHandoffPath(tmp, 'askBranch');
    const writeResult = await atomicWriteJson(answerPath, { answer: 'yes' });
    expect(writeResult.isOk()).toBe(true);

    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    expect(resumeResult.status).toBe('succeeded');

    const state = await readState(tmp);
    expect(state.status).toBe('succeeded');
    expect(state.steps['askBranch']?.status).toBe('succeeded');
    expect(state.steps['promptBranch']?.status).toBe('succeeded');
    expect(state.steps['barrier']?.status).toBe('succeeded');
    expect(state.steps['conclude']?.status).toBe('succeeded');
  });

  it('resume: conclude step is invoked after barrier succeeds', async () => {
    const concludeSpy = { called: false };
    const orchestrator = createOrchestrator({
      providers: makeRegistry({
        promptBranch: canned,
        conclude: (_req: InvocationRequest, _ctx: InvocationContext) => {
          concludeSpy.called = true;
          return canned;
        },
      }),
      runDir: tmp,
    });

    await orchestrator.run(
      makeAskParallelFlow(),
      {},
      { ...RUN_OPTS, flowDir: tmp, flowPath: ASK_PARALLEL_FLOW_FIXTURE },
    );

    const answerPath = askAnswerHandoffPath(tmp, 'askBranch');
    await atomicWriteJson(answerPath, { answer: 'yes' });

    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });
    expect(resumeResult.status).toBe('succeeded');
    expect(concludeSpy.called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: ask in parallel branch — sibling aborted mid-flight
// ---------------------------------------------------------------------------
//
// The prompt branch is given an explicit 200 ms delay via the MockProvider
// callback so the ask branch (which only needs one ENOENT readFile before
// throwing AwaitingInputSignal) fires its pause while the prompt branch is
// definitively still in-flight (status 'running').
//
// The sibling sweep in the AwaitingInputSignal catch chain transitions the
// running prompt branch: failStep('aborted by sibling pause') → resetStep,
// landing it at 'pending'. The persisted snapshot must show 'pending', NOT
// 'running', so the resume seeder can re-queue it without deadlocking.

describe('ask in parallel branch: sibling aborted mid-flight', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-parallel-slow-'));
    await writeFile(join(tmp, 'p.md'), '# test prompt', 'utf8');
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  function makeSlowRegistry(
    concludeResponses?: Record<
      string,
      InvocationResponse | ((req: InvocationRequest, ctx: InvocationContext) => InvocationResponse)
    >,
  ) {
    const slowPromptBranch = (
      _req: InvocationRequest,
      _ctx: InvocationContext,
    ): Promise<InvocationResponse> =>
      new Promise<InvocationResponse>((resolve) => setTimeout(() => resolve(canned), 200));

    return makeRegistry({
      promptBranch: slowPromptBranch,
      conclude: canned,
      ...concludeResponses,
    });
  }

  it('first run returns status:paused and pausedStepId:askBranch', async () => {
    const orchestrator = createOrchestrator({
      providers: makeSlowRegistry(),
      runDir: tmp,
    });

    const result = await orchestrator.run(makeAskParallelFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    expect(result.status).toBe('paused');
    expect(result.pausedStepId).toBe('askBranch');
  });

  it('state.json after first run: overall paused, askBranch paused, promptBranch is pending (swept from running)', async () => {
    const orchestrator = createOrchestrator({
      providers: makeSlowRegistry(),
      runDir: tmp,
    });

    await orchestrator.run(makeAskParallelFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('paused');
    expect(state.steps['askBranch']?.status).toBe('paused');
    expect(state.awaitingInput?.stepId).toBe('askBranch');
    // The sibling sweep reset the in-flight prompt branch to 'pending' — NOT 'running'.
    // This is the key behavioral guarantee: the resume seeder can re-queue 'pending'
    // steps but would deadlock on a zombie 'running' step.
    expect(state.steps['promptBranch']?.status).toBe('pending');
    expect(state.steps['barrier']?.status).toBe('pending');
    expect(state.steps['conclude']?.status).toBe('pending');
  });

  it('promptBranch status is pending, not running, after pause', async () => {
    const orchestrator = createOrchestrator({
      providers: makeSlowRegistry(),
      runDir: tmp,
    });

    await orchestrator.run(makeAskParallelFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.steps['promptBranch']?.status).not.toBe('running');
    expect(state.steps['promptBranch']?.status).toBe('pending');
  });

  it('resume after writing answer: promptBranch re-runs and overall flow succeeds', async () => {
    const orchestrator = createOrchestrator({
      providers: makeSlowRegistry(),
      runDir: tmp,
    });

    const firstResult = await orchestrator.run(
      makeAskParallelFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_PARALLEL_FLOW_FIXTURE,
      },
    );
    expect(firstResult.status).toBe('paused');

    const answerPath = askAnswerHandoffPath(tmp, 'askBranch');
    const writeResult = await atomicWriteJson(answerPath, { answer: 'yes' });
    expect(writeResult.isOk()).toBe(true);

    // On resume, promptBranch must be re-invoked (it was swept to pending, not skipped).
    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    expect(resumeResult.status).toBe('succeeded');

    const state = await readState(tmp);
    expect(state.status).toBe('succeeded');
    expect(state.steps['askBranch']?.status).toBe('succeeded');
    expect(state.steps['promptBranch']?.status).toBe('succeeded');
    expect(state.steps['barrier']?.status).toBe('succeeded');
    expect(state.steps['conclude']?.status).toBe('succeeded');
  });

  it('resume: promptBranch is re-invoked (it was reset to pending, not skipped)', async () => {
    const invokedOnResume: string[] = [];

    // First run: slow prompt branch → ask pauses the run
    const firstOrchestrator = createOrchestrator({
      providers: makeSlowRegistry(),
      runDir: tmp,
    });

    const firstResult = await firstOrchestrator.run(
      makeAskParallelFlow(),
      {},
      { ...RUN_OPTS, flowDir: tmp, flowPath: ASK_PARALLEL_FLOW_FIXTURE },
    );
    expect(firstResult.status).toBe('paused');

    // Write the answer file
    const answerPath = askAnswerHandoffPath(tmp, 'askBranch');
    await atomicWriteJson(answerPath, { answer: 'yes' });

    // Resume with a tracking registry to observe which steps actually re-run
    const resumeOrchestrator = createOrchestrator({
      providers: makeRegistry({
        promptBranch: (_req, ctx) => {
          invokedOnResume.push(ctx.stepId);
          return canned;
        },
        conclude: (_req, ctx) => {
          invokedOnResume.push(ctx.stepId);
          return canned;
        },
      }),
      runDir: tmp,
    });

    const resumeResult = await resumeOrchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });
    expect(resumeResult.status).toBe('succeeded');

    // promptBranch must be re-invoked on resume — it was swept to pending, not skipped.
    expect(invokedOnResume).toContain('promptBranch');
    // conclude must run after the barrier completes on resume.
    expect(invokedOnResume).toContain('conclude');
  });
});
