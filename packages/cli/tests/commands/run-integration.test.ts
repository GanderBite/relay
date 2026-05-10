/**
 * CLI integration tests for `relay run` — exercises the real Orchestrator
 * through the runCommand function using MockProvider. No Orchestrator mock.
 *
 * These tests cover:
 *   - exit code 0 on successful two-step flow
 *   - exit code 1 when a step fails (provider returns error)
 *   - buildSuccessStepRows produces correct SuccessStepRow shapes post-run
 *   - state.json and metrics.json are populated by the Orchestrator
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared harness — imports hoisted refs and registers all vi.mock factories.
// ---------------------------------------------------------------------------

import {
  mockLoadFlow,
  mockLoadFlowSettings,
  mockLoadGlobalSettings,
  mockParseInputFromArgv,
  mockRegisterDefaultProviders,
  mockResolveAndAuthenticate,
  mockResolveProvider,
  registryRef,
  runDirRef,
} from './_run-harness.js';

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { defineFlow, ok, ProviderRegistry, step, z } from '@ganderbite/relay-core';
import { MockProvider } from '@ganderbite/relay-core/testing';
import runCommand from '../../src/commands/run.js';
import { buildSuccessStepRows, readStateSteps } from '../../src/step-data.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixtureFlow() {
  return defineFlow({
    name: 'integration-test',
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

// ---------------------------------------------------------------------------
// Helper — build a ProviderRegistry with the given MockProvider and populate
// the shared ref so the WrappedOrchestrator picks it up.
// ---------------------------------------------------------------------------

function setupRegistry(provider: MockProvider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider);
  registryRef.current = registry;
  return registry;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let flowDir: string;
let runDir: string;
let capturedExitCode: number | undefined;

beforeEach(async () => {
  flowDir = await mkdtemp(join(tmpdir(), 'relay-int-flow-'));
  runDir = await mkdtemp(join(tmpdir(), 'relay-int-run-'));
  runDirRef.current = runDir;

  // The Orchestrator mkdir's the live/ directory itself, but pre-creating it
  // keeps the ProgressDisplay watcher happy if it fires before the Orchestrator does.
  await mkdir(join(runDir, 'live'), { recursive: true });

  // Minimal prompt file — content is ignored by MockProvider.
  await writeFile(join(flowDir, 'prompt.md'), '# integration test prompt\n', 'utf8');

  vi.clearAllMocks();

  // Build and register the default (working) provider for this test.
  const provider = new MockProvider({
    responses: {
      stepA: mkResponse('{}'),
      stepB: mkResponse('{}'),
    },
  });
  setupRegistry(provider);

  // Wire CLI-layer stubs.
  mockRegisterDefaultProviders.mockReturnValue(undefined);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockLoadFlowSettings.mockResolvedValue(ok(null));
  mockResolveProvider.mockReturnValue(ok(provider));
  mockResolveAndAuthenticate.mockResolvedValue({
    provider,
    authState: { ok: true, billingSource: 'subscription', detail: 'subscription (test)' },
  });

  const flow = makeFixtureFlow();
  mockLoadFlow.mockResolvedValue(ok({ flow, dir: flowDir, pkg: {}, source: 'path' as const }));
  mockParseInputFromArgv.mockReturnValue(ok({}));

  // Capture process.exit without stopping execution — tests inspect the code.
  capturedExitCode = undefined;
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    capturedExitCode = typeof code === 'number' ? code : 0;
    return undefined as never;
  });

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(flowDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('run-integration — success path', () => {
  it('[RUN-INT-001] exits 0 when both steps complete successfully', async () => {
    await runCommand(['integration-test', '.'], { worktree: false, provider: 'mock' });
    expect(capturedExitCode).toBe(0);
  });

  it('[RUN-INT-002] state.json records both steps as succeeded after a successful run', async () => {
    await runCommand(['integration-test', '.'], { worktree: false, provider: 'mock' });

    const stateSteps = await readStateSteps(runDir);
    expect(stateSteps['stepA']?.status).toBe('succeeded');
    expect(stateSteps['stepB']?.status).toBe('succeeded');
  });

  it('[RUN-INT-003] buildSuccessStepRows returns one correctly-shaped row per step', async () => {
    await runCommand(['integration-test', '.'], { worktree: false, provider: 'mock' });

    const rows = await buildSuccessStepRows(runDir, ['stepA', 'stepB']);

    expect(rows).toHaveLength(2);

    // Step order must match the requested topoOrder.
    expect(rows[0]?.name).toBe('stepA');
    expect(rows[1]?.name).toBe('stepB');

    for (const row of rows) {
      // Every field must be present with the correct type.
      expect(typeof row.name).toBe('string');
      expect(typeof row.durationMs).toBe('number');
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof row.costUsd).toBe('number');
      // model may be empty string when the step spec has no model configured —
      // the helper faithfully reflects the empty model from metrics.json.
      expect(typeof row.model).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

describe('run-integration — failure path', () => {
  it('[RUN-INT-004] exits with non-zero code when a step has no configured response', async () => {
    // Build a provider with only stepA configured. The Orchestrator will run
    // stepA (succeeds), then attempt stepB — MockProvider.stream() throws
    // StepFailureError for unconfigured steps, causing the run to fail.
    const failingProvider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB intentionally absent
      },
    });
    // Replace the registry so the Orchestrator receives the failing provider.
    setupRegistry(failingProvider);
    mockResolveProvider.mockReturnValue(ok(failingProvider));

    await runCommand(['integration-test', '.'], { worktree: false, provider: 'mock' });

    // Any non-zero exit code signals failure.
    expect(capturedExitCode).toBeGreaterThan(0);
  });
});
