/**
 * CLI end-to-end integration tests for `relay run`.
 *
 * These tests drive `runCommand` against a real compiled fixture flow — the
 * real `loadFlow()` and duck-type validation run on every test. Only the
 * provider layer (Orchestrator constructor, registerDefaultProviders,
 * loadGlobalSettings, loadFlowSettings, resolveProvider) is mocked via the
 * shared harness so no live Claude calls are made.
 *
 * Distinction from tests/commands/run-integration.test.ts:
 *   - `flow-loader.js` is NOT mocked — loadFlow() dynamically imports the
 *     real fixture dist/flow.js and validates its shape.
 *   - The flow module is generated at test time using an absolute file URL
 *     import of relay-core so the fixture resolves correctly from any tmpdir.
 *   - This exercises the full CLI → loadFlow → Orchestrator surface and
 *     detects regressions where CLI/core API contracts drift.
 *
 * Test cases:
 *   [E2E-RUN-001] Successful two-step run exits with code 0.
 *   [E2E-RUN-002] Step failure exits with a non-zero code.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Harness — registers all vi.mock factories (must be imported before other
// relay-core / CLI imports so vitest hoists the mocks correctly).
// ---------------------------------------------------------------------------

import {
  mockLoadFlowSettings,
  mockLoadGlobalSettings,
  mockRegisterDefaultProviders,
  mockResolveAndAuthenticate,
  mockResolveProvider,
  registryRef,
  runDirRef,
} from './_harness.js';

// ---------------------------------------------------------------------------
// Imports that depend on the mocks (after harness)
// ---------------------------------------------------------------------------

import { ok, ProviderRegistry } from '@ganderbite/relay-core';
import { MockProvider } from '@ganderbite/relay-core/testing';
import runCommand from '../../src/commands/run.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the relay-core dist entry used inside the generated
 * flow module. Using a file URL import makes the fixture importable from
 * any temporary directory without relying on node_modules resolution.
 */
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

/**
 * Absolute path to the static fixture directory (prompts live here).
 */
const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'mini-mock-flow');

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
 * Write a minimal compiled flow.js into <flowDir>/dist/flow.js and copy
 * the static prompt files into <flowDir>/prompts/ so the Orchestrator can
 * resolve them when it sets flowDir = <flowDir>.
 *
 * The module uses an absolute file URL import of relay-core so Node resolves
 * the dependency from the committed dist on disk rather than relying on
 * node_modules resolution inside a temp directory.
 */
async function writeFixtureFlow(flowDir: string): Promise<string> {
  const distDir = join(flowDir, 'dist');
  await mkdir(distDir, { recursive: true });
  const promptsDir = join(flowDir, 'prompts');
  await mkdir(promptsDir, { recursive: true });

  // Copy static prompt files from the committed fixtures directory.
  const { copyFile } = await import('node:fs/promises');
  await copyFile(join(FIXTURE_DIR, 'prompts', '01.md'), join(promptsDir, '01.md'));
  await copyFile(join(FIXTURE_DIR, 'prompts', '02.md'), join(promptsDir, '02.md'));

  const flowPath = join(distDir, 'flow.js');
  const source = `
import { defineFlow, step, z } from '${RELAY_CORE_URL}';
export default defineFlow({
  name: 'mini-mock',
  version: '0.1.0',
  description: 'Minimal two-step fixture flow for CLI integration tests.',
  input: z.object({ target: z.string().optional() }),
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
  return flowPath;
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

let flowDir: string;
let runDir: string;
let capturedExitCode: number | undefined;

beforeEach(async () => {
  // flowDir holds the generated dist/flow.js; the Orchestrator receives
  // FIXTURE_DIR as flowDir so it resolves prompt files from the committed
  // prompts/ directory.
  flowDir = await mkdtemp(join(tmpdir(), 'relay-e2e-flow-'));
  runDir = await mkdtemp(join(tmpdir(), 'relay-e2e-run-'));
  runDirRef.current = runDir;

  await mkdir(join(runDir, 'live'), { recursive: true });

  // Generate the flow module.
  await writeFixtureFlow(flowDir);

  vi.clearAllMocks();

  // Wire provider stubs — tests override these as needed.
  const provider = new MockProvider({
    responses: {
      stepA: mkResponse('{}'),
      stepB: mkResponse('success'),
    },
  });
  setupRegistry(provider);

  mockRegisterDefaultProviders.mockReturnValue(undefined);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockLoadFlowSettings.mockResolvedValue(ok(null));
  mockResolveProvider.mockReturnValue(ok(provider));
  mockResolveAndAuthenticate.mockResolvedValue({
    provider,
    authState: { ok: true, billingSource: 'subscription', detail: 'subscription (test)' },
  });

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
// Tests
// ---------------------------------------------------------------------------

describe('run-end-to-end — success path', () => {
  it('[E2E-RUN-001] exits 0 when both steps complete successfully', {
    timeout: 30_000,
  }, async () => {
    // Pass the flowDir path to runCommand so loadFlow() finds dist/flow.js.
    // The Orchestrator uses FIXTURE_DIR for prompt resolution (set via flagProvider
    // path in the harness WrappedOrchestrator which reads flowDir from the run opts).
    await runCommand([flowDir], { worktree: false, provider: 'mock' });

    expect(capturedExitCode).toBe(0);
  });
});

describe('run-end-to-end — failure path', () => {
  it('[E2E-RUN-002] exits with non-zero code when a step has no configured response', {
    timeout: 30_000,
  }, async () => {
    // Build a provider with only stepA configured — stepB will be missing and
    // MockProvider.stream() throws StepFailureError for unconfigured steps.
    const failingProvider = new MockProvider({
      responses: {
        stepA: mkResponse('{}'),
        // stepB intentionally absent
      },
    });
    setupRegistry(failingProvider);
    mockResolveProvider.mockReturnValue(ok(failingProvider));
    mockResolveAndAuthenticate.mockResolvedValue({
      provider: failingProvider,
      authState: { ok: true, billingSource: 'subscription', detail: 'subscription (test)' },
    });

    await runCommand([flowDir], { worktree: false, provider: 'mock' });

    expect(capturedExitCode).toBeGreaterThan(0);
  });
});
