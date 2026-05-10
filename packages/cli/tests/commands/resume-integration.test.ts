/**
 * CLI integration tests for `relay resume` — exercises the real Orchestrator
 * resume path through the resumeCommand function using MockProvider.
 *
 * Setup strategy:
 *   - A minimal flow.js file is written to a temp directory using an absolute
 *     import of relay-core's compiled dist, so the Orchestrator can dynamically
 *     re-import it during resume without needing a full package build.
 *   - The first "run" is completed via createOrchestrator directly (not via CLI)
 *     to produce a valid state.json and flow-ref.json in the runDir.
 *   - resumeCommand is then called against that runDir with MockProvider injected.
 *
 * These tests cover:
 *   - [RESUME-INT-001] Resuming a failed run completes successfully (exit 0).
 *   - [RESUME-INT-002] Already-succeeded steps are not re-invoked on resume.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable refs — hoisted so mock factories can read current-test values.
// ---------------------------------------------------------------------------

const runDirRef = vi.hoisted(() => ({ current: '' }));
const registryRef = vi.hoisted(() => ({ current: null as unknown }));

// ---------------------------------------------------------------------------
// CLI-layer stubs
// ---------------------------------------------------------------------------

const mockLoadFlow = vi.hoisted(() => vi.fn());
const mockRegisterDefaultProviders = vi.hoisted(() => vi.fn());
const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockLoadFlowSettings = vi.hoisted(() => vi.fn());
const mockResolveProvider = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();
  // Wrap the Orchestrator so that when the CLI creates `new Orchestrator({
  // runDir })` (without a providers option), the constructor injects the
  // per-test registry from registryRef. When the test itself calls
  // createOrchestrator({ providers: explicitRegistry, ... }), the explicit
  // providers take precedence (opts.providers !== undefined).
  const WrappedOrchestrator = class extends actual.Orchestrator {
    constructor(opts?: ConstructorParameters<typeof actual.Orchestrator>[0]) {
      const effectiveProviders =
        (opts as { providers?: unknown } | undefined)?.providers !== undefined
          ? (opts as { providers: unknown }).providers
          : (registryRef.current as InstanceType<typeof actual.ProviderRegistry>);
      super({
        ...(opts ?? {}),
        providers: effectiveProviders as InstanceType<typeof actual.ProviderRegistry>,
      });
    }
  };
  return {
    ...actual,
    Orchestrator: WrappedOrchestrator,
    registerDefaultProviders: () => mockRegisterDefaultProviders(),
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    loadFlowSettings: (_dir: string) => mockLoadFlowSettings(_dir),
    resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
  };
});

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
}));

vi.mock('../../src/input-parser.js', () => ({
  parseInputFromArgv: vi.fn(),
  normalizeArgvInput: (_argv: string[]) => ({ inputPrimary: '.', inputExtras: [] }),
}));

vi.mock('../../src/banner.js', () => ({
  renderStartBanner: vi.fn(() => ''),
  renderSuccessBanner: vi.fn(() => ''),
  renderFailureBanner: vi.fn(() => ''),
}));

vi.mock('../../src/paused-banner.js', () => ({
  renderPausedBanner: vi.fn(),
}));

vi.mock('../../src/progress.js', () => ({
  ProgressDisplay: class MockProgress {
    start = vi.fn();
    stop = vi.fn();
    updateRunnerMetrics = vi.fn();
  },
}));

vi.mock('../../src/telemetry.js', () => ({
  maybeSendRunEvent: vi.fn(),
  maybySendRunEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
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
// Path to relay-core dist/index.js — used when writing the inline flow module
// that the Orchestrator re-imports during resume. This resolves through the
// workspace symlink, so the path is stable across machines.
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
// Fixture helpers
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
 * Write a minimal compiled flow.js to flowDir/dist/flow.js that can be
 * dynamically imported by the Orchestrator's internal importFlow(). The file
 * uses an absolute URL import so Node resolves relay-core from the dist on disk
 * rather than going through bare-specifier resolution (which fails for a
 * temporary directory outside node_modules).
 */
async function writeFlowModule(flowDir: string): Promise<string> {
  const distDir = join(flowDir, 'dist');
  await mkdir(distDir, { recursive: true });
  const flowPath = join(distDir, 'flow.js');
  const source = `
import { defineFlow, step, z } from '${RELAY_CORE_URL}';
export default defineFlow({
  name: 'resume-integration',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    stepA: step.prompt({
      promptFile: 'prompt.md',
      output: { handoff: 'a-out' },
    }),
    stepB: step.prompt({
      promptFile: 'prompt.md',
      dependsOn: ['stepA'],
      output: { handoff: 'b-out' },
    }),
  },
});
`.trimStart();
  await writeFile(flowPath, source, 'utf8');
  return flowPath;
}

function makeFlow() {
  return defineFlow({
    name: 'resume-integration',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      stepA: step.prompt({
        promptFile: 'prompt.md',
        output: { handoff: 'a-out' },
      }),
      stepB: step.prompt({
        promptFile: 'prompt.md',
        dependsOn: ['stepA'],
        output: { handoff: 'b-out' },
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

let baseDir: string; // tmpdir base — process.cwd() is mocked to this
let flowDir: string; // flow package dir with prompt.md and dist/flow.js
let runId: string; // 6-hex run id — matches basename of runDir
let runDir: string; // <baseDir>/.relay/runs/<runId> — structure resumeCommand expects
let flowPath: string; // absolute path to dist/flow.js for the Orchestrator
let capturedExitCode: number | undefined;

beforeEach(async () => {
  // Create a temp base dir and mock process.cwd() to return it so resumeCommand
  // constructs the expected path: join(cwd, '.relay', 'runs', runId).
  baseDir = await mkdtemp(join(tmpdir(), 'relay-res-base-'));
  flowDir = await mkdtemp(join(tmpdir(), 'relay-res-flow-'));

  // Create the runDir at the path resumeCommand will look for.
  // runId is a 6-hex string (matches the CLI convention).
  runId = 'a1b2c3';
  runDir = join(baseDir, '.relay', 'runs', runId);
  runDirRef.current = runDir;

  await mkdir(join(runDir, 'live'), { recursive: true });

  // Write the flow module first (which creates flowDir/dist/).
  // The prompt file is placed in flowDir/dist/ because the Orchestrator derives
  // flowDir as dirname(flowRef.flowPath) = flowDir/dist/, and resolvePromptPath
  // enforces that promptFile stays within that directory.
  flowPath = await writeFlowModule(flowDir);
  await writeFile(join(flowDir, 'dist', 'prompt.md'), '# resume test prompt\n', 'utf8');

  vi.clearAllMocks();

  mockRegisterDefaultProviders.mockReturnValue(undefined);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockLoadFlowSettings.mockResolvedValue(ok(null));

  // resumeCommand calls loadFlow(flowRef.flowPath, cwd) to get the CLI-level
  // flow for the pre-resume banner and step metadata. Return the in-memory
  // flow so the banner has the right step count and order.
  const flow = makeFlow();
  mockLoadFlow.mockResolvedValue(ok({ flow, dir: flowDir, pkg: {}, source: 'path' as const }));

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

describe('resume-integration', () => {
  it('[RESUME-INT-001] resuming a failed run completes successfully (exit 0)', async () => {
    // --- Phase 1: Run the flow to a state where stepA succeeds and stepB fails ---
    const phase1Provider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB absent — causes the run to fail at stepB
      },
    });
    const phase1Registry = setupRegistry(phase1Provider);

    // flowDir for Orchestrator is the directory containing flow.js and prompt.md,
    // which is flowDir/dist (since writeFlowModule writes flow.js there, and we
    // also placed prompt.md there for the resume path to find it).
    const effectiveFlowDir = join(flowDir, 'dist');
    const orch = createOrchestrator({ providers: phase1Registry, runDir });
    await orch.run(
      makeFlow(),
      {},
      {
        flowDir: effectiveFlowDir,
        flowPath,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // Verify state: stepA succeeded, stepB failed.
    const stateBefore = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as {
      steps: Record<string, { status: string }>;
    };
    expect(stateBefore.steps['stepA']?.status).toBe('succeeded');
    expect(stateBefore.steps['stepB']?.status).toBe('failed');

    // --- Phase 2: Resume with a provider that has stepB configured ---
    const phase2Provider = new MockProvider({
      responses: {
        // stepA is absent — if the resume re-invokes it, MockProvider throws.
        stepB: mkResponse('{}'),
      },
    });
    setupRegistry(phase2Provider);
    mockResolveProvider.mockReturnValue(ok(phase2Provider));

    await resumeCommand([runId], { worktree: false, provider: 'mock' });

    // resumeCommand only calls process.exit() on error; on success it returns
    // normally without calling process.exit(). A missing exit code (undefined)
    // therefore means the command succeeded without an error exit.
    expect(capturedExitCode).toBeUndefined();
  });

  it('[RESUME-INT-002] already-succeeded steps are not re-invoked on resume', async () => {
    // --- Phase 1: Run the flow to failure at stepB ---
    const phase1Provider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB absent — run fails at stepB
      },
    });
    const phase1Registry = setupRegistry(phase1Provider);

    // flowDir for Orchestrator is the directory containing flow.js and prompt.md,
    // which is flowDir/dist (since writeFlowModule writes flow.js there, and we
    // also placed prompt.md there for the resume path to find it).
    const effectiveFlowDir = join(flowDir, 'dist');
    const orch = createOrchestrator({ providers: phase1Registry, runDir });
    await orch.run(
      makeFlow(),
      {},
      {
        flowDir: effectiveFlowDir,
        flowPath,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // --- Phase 2: Resume. Track which steps get invoked. ---
    const invokedSteps: string[] = [];
    const phase2Provider = new MockProvider({
      responses: {
        // stepA must NOT be called — it already succeeded.
        // If it IS called, MockProvider will not find it in responses and throw,
        // causing the test to fail with a non-zero exit code.
        stepB: (_req: unknown, ctx: { stepId: string }) => {
          invokedSteps.push(ctx.stepId);
          return mkResponse('{}');
        },
      },
    });
    setupRegistry(phase2Provider);
    mockResolveProvider.mockReturnValue(ok(phase2Provider));

    await resumeCommand([runId], { worktree: false, provider: 'mock' });

    // resumeCommand returns normally on success (no process.exit call).
    expect(capturedExitCode).toBeUndefined();

    // stepA must NOT have been re-invoked.
    expect(invokedSteps).not.toContain('stepA');

    // stepB must have been invoked exactly once.
    expect(invokedSteps).toContain('stepB');
    expect(invokedSteps.filter((s) => s === 'stepB')).toHaveLength(1);
  });
});
