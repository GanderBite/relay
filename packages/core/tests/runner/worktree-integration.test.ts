/**
 * Integration tests for the Orchestrator's worktree lifecycle.
 *
 * The worktree module is mocked so no real git subprocesses run. The
 * Orchestrator itself runs against real filesystem state (temp dir) using
 * MockProvider. Tests verify that:
 *
 * - createWorktree / removeWorktree are called with the right arguments
 * - the run still proceeds (exit 0) when git is not available (auto mode)
 * - worktree: false suppresses every git call
 * - invocationContext.cwd is threaded into provider calls when isolation is active
 * - concurrent runs each receive a distinct runId in their worktree path
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the worktree module. vi.mock is hoisted before any import, so the
// Orchestrator will load our fakes instead of the real execFile-backed funcs.
// ---------------------------------------------------------------------------
vi.mock('../../src/runner/worktree.js', () => ({
  isGitRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

import { err, ok } from 'neverthrow';
import { ERROR_CODES, PipelineError } from '../../src/errors.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationContext, InvocationResponse } from '../../src/providers/types.js';
import { defineRace } from '../../src/race/define.js';
import { runner } from '../../src/race/runner.js';
import { createWorktree, isGitRepo, removeWorktree } from '../../src/runner/worktree.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CANNED: InvocationResponse = {
  text: '{}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function makeGitErr(msg = 'not a git repository'): PipelineError {
  return new PipelineError(msg, ERROR_CODES.RUNNER_FAILURE, {});
}

function singleStepRace() {
  return defineRace({
    name: 'wt-test',
    version: '0.1.0',
    input: z.object({}),
    runners: {
      step: runner.prompt({ promptFile: 'p.md', output: { baton: 'step-out' } }),
    },
  });
}

function buildOrchestrator(tmp: string) {
  const provider = new MockProvider({ responses: { step: CANNED } });
  const registry = new ProviderRegistry();
  registry.register(provider);
  const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
  return { orchestrator, provider };
}

// Typed helpers for mocked functions
const mockedIsGitRepo = vi.mocked(isGitRepo);
const mockedCreateWorktree = vi.mocked(createWorktree);
const mockedRemoveWorktree = vi.mocked(removeWorktree);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Orchestrator — worktree lifecycle (integration)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-wt-int-'));
    await writeFile(join(tmp, 'p.md'), '# test prompt', 'utf8');

    // Reset all mocks between tests so call counts are clean.
    mockedIsGitRepo.mockReset();
    mockedCreateWorktree.mockReset();
    mockedRemoveWorktree.mockReset();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // (a) worktree: 'auto' — git repo present
  // -------------------------------------------------------------------------

  describe("worktree: 'auto' when inside a git repo", () => {
    it('calls createWorktree with the runId and gitRoot returned by isGitRepo', async () => {
      const fakeGitRoot = '/fake/git-root';
      const fakeWorktreePath = join(tmpdir(), 'relay-worktrees', 'xxxxxx');

      mockedIsGitRepo.mockResolvedValue(ok(fakeGitRoot));
      mockedCreateWorktree.mockResolvedValue(ok(fakeWorktreePath));
      mockedRemoveWorktree.mockResolvedValue(ok(undefined));

      const { orchestrator } = buildOrchestrator(tmp);
      const result = await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
      );

      expect(result.status).toBe('succeeded');

      // createWorktree must have been called once with a runId and the gitRoot
      expect(mockedCreateWorktree).toHaveBeenCalledTimes(1);
      const createArgs = mockedCreateWorktree.mock.calls[0]?.[0];
      expect(createArgs).toBeDefined();
      expect(createArgs?.gitRoot).toBe(fakeGitRoot);
      // runId is a random 6-hex string produced by the Orchestrator; just
      // verify it is a non-empty string that appears somewhere in the call
      expect(typeof createArgs?.runId).toBe('string');
      expect(createArgs?.runId.length).toBeGreaterThan(0);
    });

    it('calls removeWorktree in the finally block even when a step throws', async () => {
      const fakeGitRoot = '/fake/git-root';
      const fakeWorktreePath = join(tmpdir(), 'relay-worktrees', 'cleanup-test');

      mockedIsGitRepo.mockResolvedValue(ok(fakeGitRoot));
      mockedCreateWorktree.mockResolvedValue(ok(fakeWorktreePath));
      mockedRemoveWorktree.mockResolvedValue(ok(undefined));

      // Provider that throws during the step execution
      const throwingProvider = new MockProvider({
        responses: {
          step: () => {
            throw new Error('step exploded');
          },
        },
      });
      const registry = new ProviderRegistry();
      registry.register(throwingProvider);
      const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

      const result = await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
      );

      // The run records 'failed' (step threw) but removeWorktree still ran
      expect(result.status).toBe('failed');
      expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
      const removeArgs = mockedRemoveWorktree.mock.calls[0]?.[0];
      expect(removeArgs?.worktreePath).toBe(fakeWorktreePath);
      expect(removeArgs?.gitRoot).toBe(fakeGitRoot);
    });
  });

  // -------------------------------------------------------------------------
  // (b) worktree: 'auto' — not inside a git repo
  // -------------------------------------------------------------------------

  describe("worktree: 'auto' when NOT inside a git repo", () => {
    it('does not create a worktree and run still succeeds', async () => {
      mockedIsGitRepo.mockResolvedValue(err(makeGitErr('not a git repository')));
      // createWorktree and removeWorktree should never be reached

      const { orchestrator } = buildOrchestrator(tmp);
      const result = await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
      );

      expect(result.status).toBe('succeeded');
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) worktree: false — feature disabled entirely
  // -------------------------------------------------------------------------

  describe('worktree: false', () => {
    it('never calls isGitRepo, createWorktree, or removeWorktree', async () => {
      const { orchestrator } = buildOrchestrator(tmp);
      const result = await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false },
      );

      expect(result.status).toBe('succeeded');
      expect(mockedIsGitRepo).not.toHaveBeenCalled();
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (d) invocationContext.cwd — worktree path threaded into provider calls
  // -------------------------------------------------------------------------

  describe('invocationContext.cwd propagation', () => {
    it('sets cwd to the worktree path on provider InvocationContext when a worktree is created', async () => {
      // Use tmp as gitRoot so that relative(gitRoot, raceDir) === '' (raceDir === tmp === gitRoot).
      // That makes worktreeCwd = join(fakeWorktreePath, '') = fakeWorktreePath.
      // raceDir must be tmp so the prompt file (p.md) resolves correctly.
      const fakeGitRoot = tmp;
      const fakeWorktreePath = join(tmpdir(), 'relay-worktrees', 'cwd-test');

      mockedIsGitRepo.mockResolvedValue(ok(fakeGitRoot));
      mockedCreateWorktree.mockResolvedValue(ok(fakeWorktreePath));
      mockedRemoveWorktree.mockResolvedValue(ok(undefined));

      const capturedCwds: Array<string | undefined> = [];
      const capturingProvider = new MockProvider({
        responses: {
          step: (
            _req: Parameters<typeof MockProvider.prototype.invoke>[0],
            ctx: InvocationContext,
          ) => {
            capturedCwds.push(ctx.cwd);
            return CANNED;
          },
        },
      });
      const registry = new ProviderRegistry();
      registry.register(capturingProvider);
      const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

      // raceDir === fakeGitRoot === tmp
      // => relative(fakeGitRoot, tmp) === '' => worktreeCwd = fakeWorktreePath
      await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
      );

      expect(capturedCwds).toHaveLength(1);
      expect(capturedCwds[0]).toBe(fakeWorktreePath);
    });

    it('does not set cwd on InvocationContext when no worktree is created', async () => {
      mockedIsGitRepo.mockResolvedValue(err(makeGitErr('no repo')));

      const capturedCwds: Array<string | undefined> = [];
      const capturingProvider = new MockProvider({
        responses: {
          step: (
            _req: Parameters<typeof MockProvider.prototype.invoke>[0],
            ctx: InvocationContext,
          ) => {
            capturedCwds.push(ctx.cwd);
            return CANNED;
          },
        },
      });
      const registry = new ProviderRegistry();
      registry.register(capturingProvider);
      const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

      await orchestrator.run(
        singleStepRace(),
        {},
        { raceDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
      );

      expect(capturedCwds).toHaveLength(1);
      expect(capturedCwds[0]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (e) Concurrent isolation — each run gets a distinct runId in its worktree
  // -------------------------------------------------------------------------

  describe('concurrent runs', () => {
    it('each concurrent run receives a distinct runId in its createWorktree call', async () => {
      // Two separate temp dirs so each orchestrator has its own runDir and raceDir.
      // Each has its own p.md so prompt resolution succeeds.
      const tmpA = await mkdtemp(join(tmpdir(), 'relay-wt-con-a-'));
      const tmpB = await mkdtemp(join(tmpdir(), 'relay-wt-con-b-'));
      try {
        await writeFile(join(tmpA, 'p.md'), '# test', 'utf8');
        await writeFile(join(tmpB, 'p.md'), '# test', 'utf8');

        // isGitRepo returns each dir's own path as the git root so that
        // relative(gitRoot, raceDir) === '' and worktreeCwd = worktreePath.
        mockedIsGitRepo.mockImplementation(async (dir) => ok(dir));

        // createWorktree captures the runId and returns a unique worktree path
        const capturedRunIds: string[] = [];
        mockedCreateWorktree.mockImplementation(async (opts) => {
          capturedRunIds.push(opts.runId);
          return ok(join(tmpdir(), 'relay-worktrees', opts.runId));
        });
        mockedRemoveWorktree.mockResolvedValue(ok(undefined));

        const providerA = new MockProvider({ responses: { step: CANNED } });
        const registryA = new ProviderRegistry();
        registryA.register(providerA);
        const orchestratorA = createOrchestrator({ providers: registryA, runDir: tmpA });

        const providerB = new MockProvider({ responses: { step: CANNED } });
        const registryB = new ProviderRegistry();
        registryB.register(providerB);
        const orchestratorB = createOrchestrator({ providers: registryB, runDir: tmpB });

        // Start both runs concurrently
        const runA = orchestratorA.run(
          singleStepRace(),
          {},
          { raceDir: tmpA, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
        );
        const runB = orchestratorB.run(
          singleStepRace(),
          {},
          { raceDir: tmpB, authTimeoutMs: 1_000, flagProvider: 'mock', worktree: 'auto' },
        );

        const [resultA, resultB] = await Promise.all([runA, runB]);

        expect(resultA.status).toBe('succeeded');
        expect(resultB.status).toBe('succeeded');

        // Both createWorktree calls must have been made
        expect(mockedCreateWorktree).toHaveBeenCalledTimes(2);

        // Each run gets a unique runId
        expect(capturedRunIds).toHaveLength(2);
        expect(capturedRunIds[0]).not.toBe(capturedRunIds[1]);

        // The runIds used in the Orchestrator result match the worktree call args
        expect(capturedRunIds).toContain(resultA.runId);
        expect(capturedRunIds).toContain(resultB.runId);
      } finally {
        await rm(tmpA, { recursive: true, force: true });
        await rm(tmpB, { recursive: true, force: true });
      }
    });
  });
});
