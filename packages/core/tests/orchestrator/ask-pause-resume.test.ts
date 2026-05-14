/**
 * Orchestrator-level tests for flows that include ask steps. Cover the full
 * pause/resume round-trip: a fresh run reaches an ask step, pauses, persists
 * state. The CLI-equivalent path then writes the answer file. Resume picks up
 * the paused step, reads the answer map, publishes it as a regular handoff,
 * and the downstream prompt step consumes it via contextFrom.
 */

// ---------------------------------------------------------------------------
// Mock the worktree module. vi.mock is hoisted before any import, so the
// Orchestrator will load our fakes instead of the real execFile-backed funcs.
// The existing tests in this file pass worktree: false in RUN_OPTS, which
// causes setupWorktree to return early before any mock function is called.
// Only the new 'worktree preserved across pause/resume' describe block sets
// worktree: 'auto', so these mocks only matter there.
// ---------------------------------------------------------------------------
vi.mock('../../src/util/worktree.js', () => ({
  isGitRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  probeWorktree: vi.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  createWorktree,
  isGitRepo,
  probeWorktree,
  removeWorktree,
} from '../../src/util/worktree.js';
import { z } from '../../src/zod.js';

// Typed helpers for the worktree mocks used in the new describe block.
const mockedIsGitRepo = vi.mocked(isGitRepo);
const mockedCreateWorktree = vi.mocked(createWorktree);
const mockedRemoveWorktree = vi.mocked(removeWorktree);
const mockedProbeWorktree = vi.mocked(probeWorktree);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ASK_FLOW_FIXTURE = join(HERE, 'fixtures', 'ask-then-prompt-flow.ts');

const canned: InvocationResponse = {
  text: '{"result":"ok"}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

const TEXT_QUESTION = { id: 'name', kind: 'text' as const, label: 'Your name?' };

interface PersistedRunState {
  status: string;
  steps: Record<string, { status: string; handoffs?: string[] }>;
  awaitingInput?: { stepId: string; questions: unknown[] } | undefined;
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

function makeAskThenPromptFlow() {
  return defineFlow({
    name: 'ask-then-prompt',
    version: '0.0.1',
    input: z.object({}),
    steps: {
      gather: step.ask({ questions: [TEXT_QUESTION] }),
      execute: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['gather'],
        contextFrom: ['gather'],
        output: { handoff: 'result' },
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

describe('orchestrator — ask step pause/resume round-trip', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-orch-'));
    await writeFile(join(tmp, 'p.md'), '# test prompt {{gather.name}}', 'utf8');
  });

  afterEach(async () => {
    // Live-state writes are fire-and-forget; on a fast pause the helper may
    // still be flushing its rename when afterEach fires. Retry the recursive
    // rm a couple of times so the test file is not flake-prone for reasons
    // unrelated to the ask executor under test.
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

  it('first pass: orchestrator returns RunResult{status:paused, pausedStepId} and downstream is not invoked', async () => {
    const executeSpy = vi.fn(() => canned);
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: executeSpy }),
      runDir: tmp,
    });

    const result = await orchestrator.run(
      makeAskThenPromptFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
      },
    );

    expect(result.status).toBe('paused');
    expect(result.pausedStepId).toBe('gather');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('first pass: state.json records status:paused and awaitingInput populated for the ask step', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: canned }),
      runDir: tmp,
    });

    await orchestrator.run(makeAskThenPromptFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const state = await readState(tmp);
    expect(state.status).toBe('paused');
    expect(state.steps['gather']?.status).toBe('paused');
    expect(state.awaitingInput?.stepId).toBe('gather');
    expect(state.awaitingInput?.questions).toHaveLength(1);
  });

  it('first pass: no answer file is written yet', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: canned }),
      runDir: tmp,
    });

    await orchestrator.run(makeAskThenPromptFlow(), {}, { ...RUN_OPTS, flowDir: tmp });

    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await expect(readFile(answerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resume: orchestrator picks up the paused step, publishes the answer handoff, and runs downstream', async () => {
    // Use the on-disk fixture so resume can re-import the flow.
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: canned }),
      runDir: tmp,
    });

    const firstResult = await orchestrator.run(
      makeAskThenPromptFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_FLOW_FIXTURE,
      },
    );
    expect(firstResult.status).toBe('paused');

    // Operator-equivalent: write the answer file at the conventional path.
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    const writeResult = await atomicWriteJson(answerPath, { name: 'Alice' });
    expect(writeResult.isOk()).toBe(true);

    // Resume the run.
    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });

    expect(resumeResult.status).toBe('succeeded');

    const state = await readState(tmp);
    expect(state.status).toBe('succeeded');
    expect(state.steps['gather']?.status).toBe('succeeded');
    expect(state.steps['execute']?.status).toBe('succeeded');

    // The orchestrator publishes the answer map as a handoff named after the
    // ask step's id. Read that file to confirm the contents survived.
    const publishedHandoff = await readFile(join(tmp, 'handoffs', 'gather.json'), 'utf8');
    expect(JSON.parse(publishedHandoff)).toEqual({ name: 'Alice' });

    // The ask step's StepState records the published handoff name (the step
    // id) so downstream tooling can discover what the step produced.
    expect(state.steps['gather']?.handoffs).toEqual(['gather']);
  });

  it('resume: downstream prompt step receives the answer map via contextFrom', async () => {
    let observedPrompt: string | undefined;
    const orchestrator = createOrchestrator({
      providers: makeRegistry({
        execute: (req: InvocationRequest) => {
          observedPrompt = req.prompt;
          return canned;
        },
      }),
      runDir: tmp,
    });

    await orchestrator.run(
      makeAskThenPromptFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_FLOW_FIXTURE,
      },
    );

    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await atomicWriteJson(answerPath, { name: 'Carol' });

    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });
    expect(resumeResult.status).toBe('succeeded');

    expect(observedPrompt).toBeDefined();
    // Templated variable {{gather.name}} renders the answer.
    expect(observedPrompt).toContain('Carol');
    // Context block carries the full answer map under the published handoff name.
    expect(observedPrompt).toContain('<c name="gather">');
  });

  it('resume with malformed answer file: returns failed run, downstream not invoked', async () => {
    const executeSpy = vi.fn(() => canned);
    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: executeSpy }),
      runDir: tmp,
    });

    await orchestrator.run(
      makeAskThenPromptFlow(),
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: ASK_FLOW_FIXTURE,
      },
    );

    // Write malformed JSON at the answer path. Ensure the handoffs dir
    // exists — the first pass did not produce any handoffs, so the directory
    // may not have been created yet.
    await mkdir(join(tmp, 'handoffs'), { recursive: true });
    await writeFile(askAnswerHandoffPath(tmp, 'gather'), 'not json{', 'utf8');

    const resumeResult = await orchestrator.resume(tmp, { ...RUN_OPTS, flowDir: tmp });
    expect(resumeResult.status).toBe('failed');
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worktree preservation across ask pause/resume
// ---------------------------------------------------------------------------

describe('worktree preserved across pause/resume', () => {
  let tmp: string;
  let fakeWorktreePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-wt-'));
    await writeFile(join(tmp, 'p.md'), '# test prompt {{gather.name}}', 'utf8');

    fakeWorktreePath = await mkdtemp(join(tmpdir(), 'relay-ask-wt-fake-'));

    // Default: probeWorktree returns a non-existent path so setupWorktree
    // falls through to createWorktree on every call.
    mockedIsGitRepo.mockReset();
    mockedCreateWorktree.mockReset();
    mockedRemoveWorktree.mockReset();
    mockedProbeWorktree.mockReset();
    mockedProbeWorktree.mockReturnValue('/nonexistent-probe-path-ask-wt-test');
    mockedIsGitRepo.mockResolvedValue(ok(tmp));
    mockedCreateWorktree.mockResolvedValue(ok(fakeWorktreePath));
    mockedRemoveWorktree.mockResolvedValue(ok(undefined));
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        await rm(fakeWorktreePath, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeWorktreePath, { recursive: true, force: true });
  });

  it('file written before ask pause is readable after resume when worktree is preserved', async () => {
    const WORKTREE_OPTS = {
      authTimeoutMs: 1_000,
      flagProvider: 'mock',
      worktree: 'auto' as const,
      flowDir: tmp,
    };

    // Write a sentinel file into the fake worktree before the run so we can
    // confirm it survives the paused exit (i.e. removeWorktree not called).
    const sentinelPath = join(fakeWorktreePath, 'relay-sentinel.txt');
    await writeFile(sentinelPath, 'pre-pause-content', 'utf8');

    const orchestrator = createOrchestrator({
      providers: makeRegistry({ execute: canned }),
      runDir: tmp,
    });

    const firstResult = await orchestrator.run(
      makeAskThenPromptFlow(),
      {},
      { ...WORKTREE_OPTS, flowPath: ASK_FLOW_FIXTURE },
    );

    expect(firstResult.status).toBe('paused');

    // removeWorktree must NOT have been called — the worktree is preserved.
    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(0);

    // The sentinel file must still exist in the fake worktree path.
    const content = await readFile(sentinelPath, 'utf8');
    expect(content).toBe('pre-pause-content');

    // Write the answer file so resume can proceed.
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    const writeResult = await atomicWriteJson(answerPath, { name: 'Bob' });
    expect(writeResult.isOk()).toBe(true);

    // On resume, re-use the same mock configuration (createWorktree returns
    // the same fakeWorktreePath — in production the real worktree would be
    // adopted via the access() probe, but since fakeWorktreePath is a real
    // dir in this test, probeWorktree returning a real path causes adoption).
    // Configure probeWorktree to return the real fakeWorktreePath so that
    // access(fakeWorktreePath) succeeds and setupWorktree adopts it without
    // calling createWorktree again.
    mockedProbeWorktree.mockReturnValue(fakeWorktreePath);
    mockedCreateWorktree.mockReset();

    const resumeResult = await orchestrator.resume(tmp, WORKTREE_OPTS);
    expect(resumeResult.status).toBe('succeeded');

    // removeWorktree must have been called exactly once after resume.
    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
    // createWorktree must NOT have been called on resume (adopted existing).
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('abort and failure runs still call removeWorktree (teardown not regressed)', async () => {
    // Use a flow that fails — the provider throws during step execution.
    const throwingRegistry = (() => {
      const throwingProvider = new MockProvider({
        responses: {
          step: () => {
            throw new Error('provider exploded');
          },
        },
      });
      const r = new ProviderRegistry();
      r.register(throwingProvider);
      return r;
    })();

    const failingFlow = defineFlow({
      name: 'failing-flow',
      version: '0.0.1',
      input: z.object({}),
      steps: {
        step: step.prompt({ promptFile: 'p.md', output: { handoff: 'out' } }),
      },
    });

    const orchestrator = createOrchestrator({
      providers: throwingRegistry,
      runDir: tmp,
    });

    const result = await orchestrator.run(
      failingFlow,
      {},
      {
        authTimeoutMs: 1_000,
        flagProvider: 'mock',
        worktree: 'auto' as const,
        flowDir: tmp,
      },
    );

    expect(result.status).toBe('failed');
    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
    const removeArgs = mockedRemoveWorktree.mock.calls[0]?.[0];
    expect(removeArgs?.worktreePath).toBe(fakeWorktreePath);
  });
});
