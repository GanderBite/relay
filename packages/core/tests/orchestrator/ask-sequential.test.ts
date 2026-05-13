/**
 * Orchestrator-level test for two sequential top-level ask steps under manual
 * relay answer mode (no auto-answer recursion).
 *
 * Regression guard: before task_201's fix, the orchestrator's recursive
 * auto-answer path attempted to re-enter the answer loop after a second ask
 * pause, throwing a ReferenceError instead of returning a paused RunResult.
 * This test ensures that path can never silently regress.
 *
 * Topology: step-ask-1 -> step-ask-2
 *
 * Round-trip:
 *   1. run()   → paused at step-ask-1
 *   2. write answer for step-ask-1
 *   3. resume() → paused at step-ask-2  ← regression check
 *   4. write answer for step-ask-2
 *   5. resume() → succeeded
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { askAnswerHandoffPath } from '../../src/orchestrator/exec/ask.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { atomicWriteJson } from '../../src/util/atomic-write.js';
import { z } from '../../src/zod.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ASK_SEQUENTIAL_FLOW_FIXTURE = join(HERE, 'fixtures', 'ask-sequential-flow.ts');

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

interface PersistedRunState {
  status: string;
  steps: Record<string, { status: string }>;
  awaitingInput?: { stepId: string; questions: unknown[] } | undefined;
}

function makeRegistry(responses: Record<string, InvocationResponse> = {}) {
  const provider = new MockProvider({ responses });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

function makeTwoAskFlow() {
  return defineFlow({
    name: 'ask-sequential-flow',
    version: '0.0.1',
    input: z.object({}),
    steps: {
      'step-ask-1': step.ask({
        questions: [{ id: 'first', kind: 'text', label: 'First question?' }],
      }),
      'step-ask-2': step.ask({
        questions: [{ id: 'second', kind: 'text', label: 'Second question?' }],
        dependsOn: ['step-ask-1'],
      }),
    },
  });
}

async function readState(runDir: string): Promise<PersistedRunState> {
  const raw = await readFile(join(runDir, 'state.json'), 'utf8');
  return JSON.parse(raw) as PersistedRunState;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator — two sequential top-level ask steps', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-seq-'));
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

  it('first run: returns status:paused and pausedStepId points at step-ask-1', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    const result = await orchestrator.run(makeTwoAskFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    expect(result.status).toBe('paused');
    expect(result.pausedStepId).toBe('step-ask-1');
  });

  it('first run: state.json records overall status:paused and step-ask-1 paused', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    await orchestrator.run(makeTwoAskFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('paused');
    expect(state.steps['step-ask-1']?.status).toBe('paused');
    expect(state.awaitingInput?.stepId).toBe('step-ask-1');
  });

  it('first resume (after step-ask-1 answer): returns status:paused and pausedStepId points at step-ask-2 — regression check', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    // First run — pauses at step-ask-1.
    const firstResult = await orchestrator.run(
      makeTwoAskFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_SEQUENTIAL_FLOW_FIXTURE,
      },
    );
    expect(firstResult.status).toBe('paused');

    // Write the answer file for step-ask-1.
    const answerPath1 = askAnswerHandoffPath(tmp, 'step-ask-1');
    const writeResult1 = await atomicWriteJson(answerPath1, { first: 'answer one' });
    expect(writeResult1.isOk()).toBe(true);

    // Resume — must return paused at step-ask-2, NOT throw.
    // This is the regression check: the old recursive auto-answer path would
    // crash here with a ReferenceError instead of returning a paused result.
    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    expect(resumeResult.status).toBe('paused');
    expect(resumeResult.pausedStepId).toBe('step-ask-2');
  });

  it('first resume: state.json records step-ask-1 succeeded and step-ask-2 paused', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    await orchestrator.run(
      makeTwoAskFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_SEQUENTIAL_FLOW_FIXTURE,
      },
    );

    const answerPath1 = askAnswerHandoffPath(tmp, 'step-ask-1');
    await atomicWriteJson(answerPath1, { first: 'answer one' });

    await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('paused');
    expect(state.steps['step-ask-1']?.status).toBe('succeeded');
    expect(state.steps['step-ask-2']?.status).toBe('paused');
    expect(state.awaitingInput?.stepId).toBe('step-ask-2');
  });

  it('second resume (after step-ask-2 answer): returns status:succeeded', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    // First run — pauses at step-ask-1.
    await orchestrator.run(
      makeTwoAskFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_SEQUENTIAL_FLOW_FIXTURE,
      },
    );

    // Write answer for step-ask-1 and resume.
    const answerPath1 = askAnswerHandoffPath(tmp, 'step-ask-1');
    await atomicWriteJson(answerPath1, { first: 'answer one' });
    const secondResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });
    expect(secondResult.status).toBe('paused');
    expect(secondResult.pausedStepId).toBe('step-ask-2');

    // Write answer for step-ask-2 and resume again.
    const answerPath2 = askAnswerHandoffPath(tmp, 'step-ask-2');
    const writeResult2 = await atomicWriteJson(answerPath2, { second: 'answer two' });
    expect(writeResult2.isOk()).toBe(true);

    const finalResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    expect(finalResult.status).toBe('succeeded');
  });

  it('second resume: state.json records both ask steps succeeded', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    await orchestrator.run(
      makeTwoAskFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_SEQUENTIAL_FLOW_FIXTURE,
      },
    );

    const answerPath1 = askAnswerHandoffPath(tmp, 'step-ask-1');
    await atomicWriteJson(answerPath1, { first: 'answer one' });
    await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    const answerPath2 = askAnswerHandoffPath(tmp, 'step-ask-2');
    await atomicWriteJson(answerPath2, { second: 'answer two' });
    await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('succeeded');
    expect(state.steps['step-ask-1']?.status).toBe('succeeded');
    expect(state.steps['step-ask-2']?.status).toBe('succeeded');
  });
});
