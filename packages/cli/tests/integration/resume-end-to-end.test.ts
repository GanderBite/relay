/**
 * CLI end-to-end integration tests for `relay resume`.
 *
 * These tests drive `resumeCommand` against a real compiled fixture flow —
 * the real `loadFlow()` (called by resumeCommand to build the pre-resume
 * banner) and the real Orchestrator.resume() path run on every test. Only
 * the provider layer is mocked via the shared harness.
 *
 * Setup strategy (same as tests/commands/resume-integration.test.ts):
 *   1. Write a generated dist/flow.js to a temp flowDir.
 *   2. Run phase 1 via createOrchestrator directly — produces valid
 *      state.json and flow-ref.json with a partial result (stepA succeeded,
 *      stepB failed).
 *   3. Call resumeCommand with MockProvider that has only stepB configured
 *      — asserts that stepA is not re-invoked and the run succeeds.
 *
 * Distinction from tests/commands/resume-integration.test.ts:
 *   - `flow-loader.js` is NOT mocked — loadFlow() inside resumeCommand
 *     performs a real dynamic import and duck-type validation. Any breakage
 *     in the flow module shape or the loadFlow API surface will surface here
 *     before it reaches production.
 *
 * Test cases:
 *   [E2E-RESUME-001] Resuming a partially-failed run completes with exit 0.
 *   [E2E-RESUME-002] Already-succeeded steps are not re-invoked on resume.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Harness — must be the first import so vi.mock calls are hoisted.
// ---------------------------------------------------------------------------

import {
  mockLoadFlowSettings,
  mockLoadGlobalSettings,
  mockRegisterDefaultProviders,
  mockResolveProvider,
  registryRef,
  runDirRef,
} from './_harness.js';

// ---------------------------------------------------------------------------
// Imports that depend on the mocks
// ---------------------------------------------------------------------------

import {
  createOrchestrator,
  defineFlow,
  ok,
  ProviderRegistry,
  step,
  z,
} from '@ganderbite/relay-core';
import { MockProvider } from '@ganderbite/relay-core/testing';
import resumeCommand from '../../src/commands/resume.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

const RELAY_CORE_DIST = join(
  HERE,
  '..',
  '..',
  'node_modules',
  '@ganderbite',
  'relay-core',
  'dist',
  'index.js',
);
const RELAY_CORE_URL = pathToFileURL(RELAY_CORE_DIST).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function mkResponse(text = '{}') {
  return {
    text,
    usage: ZERO_USAGE,
    costUsd: 0.001,
    durationMs: 10,
    numTurns: 1,
    model: 'mock-model',
    stopReason: 'end_turn' as const,
  };
}

/**
 * Write a minimal flow.js into <flowDir>/dist/flow.js using an absolute
 * file URL import of relay-core so the module resolves from any temp dir.
 *
 * Also writes prompt files alongside the flow module — resumeCommand sets
 * flowDir to dirname(flowRef.flowPath) = <flowDir>/dist, so promptFile paths
 * are resolved relative to that directory.
 */
async function writeFlowModule(flowDir: string): Promise<string> {
  const distDir = join(flowDir, 'dist');
  await mkdir(distDir, { recursive: true });
  const flowPath = join(distDir, 'flow.js');
  const source = `
import { defineFlow, step, z } from '${RELAY_CORE_URL}';
export default defineFlow({
  name: 'mini-mock',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    stepA: step.prompt({
      promptFile: 'prompts/01.md',
      output: { handoff: 'a-result' },
    }),
    stepB: step.prompt({
      promptFile: 'prompts/02.md',
      dependsOn: ['stepA'],
      output: { artifact: 'result.txt' },
    }),
  },
});
`.trimStart();
  await writeFile(flowPath, source, 'utf8');

  // Prompt files reside next to the flow module (in dist/) because
  // resumeCommand derives flowDir as dirname(flowRef.flowPath) = distDir.
  await mkdir(join(distDir, 'prompts'), { recursive: true });
  await writeFile(join(distDir, 'prompts', '01.md'), '# Step A prompt\n', 'utf8');
  await writeFile(join(distDir, 'prompts', '02.md'), '# Step B prompt\n', 'utf8');

  return flowPath;
}

/**
 * In-memory flow definition that mirrors the generated flow.js.
 * Used by phase-1 createOrchestrator calls so the Orchestrator can build
 * state.json without dynamically importing the generated file.
 */
function makeFlow() {
  return defineFlow({
    name: 'mini-mock',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      stepA: step.prompt({
        promptFile: 'prompts/01.md',
        output: { handoff: 'a-result' },
      }),
      stepB: step.prompt({
        promptFile: 'prompts/02.md',
        dependsOn: ['stepA'],
        output: { artifact: 'result.txt' },
      }),
    },
  });
}

function setupRegistry(provider: MockProvider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider);
  registryRef.current = registry;
  return registry;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let baseDir: string;
let flowDir: string;
let runId: string;
let runDir: string;
let flowPath: string;
let capturedExitCode: number | undefined;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'relay-e2e-res-base-'));
  flowDir = await mkdtemp(join(tmpdir(), 'relay-e2e-res-flow-'));

  runId = 'd1e2f3';
  runDir = join(baseDir, '.relay', 'runs', runId);
  // Set runDirRef to '' so the WrappedOrchestrator does not override runDir
  // for phase-1 createOrchestrator calls (which supply it explicitly) and
  // also does not override the CLI's resumeCommand-derived runDir.
  runDirRef.current = '';

  await mkdir(join(runDir, 'live'), { recursive: true });

  flowPath = await writeFlowModule(flowDir);

  vi.clearAllMocks();

  mockRegisterDefaultProviders.mockReturnValue(undefined);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockLoadFlowSettings.mockResolvedValue(ok(null));

  capturedExitCode = undefined;
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    capturedExitCode = typeof code === 'number' ? code : 0;
    return undefined as never;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'cwd').mockReturnValue(baseDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(flowDir, { recursive: true, force: true });
  await rm(baseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resume-end-to-end', () => {
  it('[E2E-RESUME-001] resuming a partially-failed run completes with exit 0', {
    timeout: 30_000,
  }, async () => {
    // --- Phase 1: Run to failure — stepA succeeds, stepB fails ---
    const phase1Provider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB absent — MockProvider throws StepFailureError
      },
    });
    const phase1Registry = new ProviderRegistry();
    phase1Registry.register(phase1Provider);

    // flowDir for the Orchestrator is distDir (where flow.js and prompts/ live).
    const distDir = join(flowDir, 'dist');
    const orch = createOrchestrator({ providers: phase1Registry, runDir });
    await orch.run(
      makeFlow(),
      {},
      {
        flowDir: distDir,
        flowPath,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // Verify phase-1 outcome: stepA succeeded, stepB failed.
    const stateBefore = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as {
      steps: Record<string, { status: string }>;
    };
    expect(stateBefore.steps['stepA']?.status).toBe('succeeded');
    expect(stateBefore.steps['stepB']?.status).toBe('failed');

    // --- Phase 2: Resume with stepB now configured ---
    const phase2Provider = new MockProvider({
      responses: {
        // stepA absent — if re-invoked, MockProvider throws and the run fails.
        stepB: mkResponse('done'),
      },
    });
    setupRegistry(phase2Provider);
    mockResolveProvider.mockReturnValue(ok(phase2Provider));

    await resumeCommand([runId], { worktree: false, provider: 'mock' });

    // resumeCommand returns normally on success (no process.exit call needed).
    expect(capturedExitCode).toBeUndefined();
  });

  it('[E2E-RESUME-002] already-succeeded steps are not re-invoked on resume', {
    timeout: 30_000,
  }, async () => {
    // --- Phase 1: Run to failure ---
    const phase1Provider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB absent
      },
    });
    const phase1Registry = new ProviderRegistry();
    phase1Registry.register(phase1Provider);

    const distDir = join(flowDir, 'dist');
    const orch = createOrchestrator({ providers: phase1Registry, runDir });
    await orch.run(
      makeFlow(),
      {},
      {
        flowDir: distDir,
        flowPath,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // --- Phase 2: Resume — track which steps are invoked ---
    const invokedSteps: string[] = [];
    const phase2Provider = new MockProvider({
      responses: {
        // stepA must NOT be called — it already succeeded in phase 1.
        stepB: (_req: unknown, ctx: { stepId: string }) => {
          invokedSteps.push(ctx.stepId);
          return mkResponse('done');
        },
      },
    });
    setupRegistry(phase2Provider);
    mockResolveProvider.mockReturnValue(ok(phase2Provider));

    await resumeCommand([runId], { worktree: false, provider: 'mock' });

    // Success: no exit with error code.
    expect(capturedExitCode).toBeUndefined();

    // stepA must not have been re-invoked.
    expect(invokedSteps).not.toContain('stepA');

    // stepB must have been invoked exactly once.
    expect(invokedSteps.filter((s) => s === 'stepB')).toHaveLength(1);
  });
});
