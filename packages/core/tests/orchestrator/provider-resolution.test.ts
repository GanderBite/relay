/**
 * Runner end-to-end provider resolution tests.
 *
 * Verifies that the three-tier resolution chain (flag → flow settings →
 * global settings → NoProviderConfiguredError) works correctly. The settings
 * loaders are mocked at the module level so no disk I/O occurs and the home
 * directory is never touched.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The runner.ts imports loadGlobalSettings and loadRaceSettings.
// We mock both so tests never touch ~/.relay/settings.json.
// vi.hoisted ensures the references are stable across the hoisting boundary.
const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockLoadFlowSettings = vi.hoisted(() => vi.fn());

// Path is relative to THIS test file: tests/runner/ → ../../ → packages/core/
vi.mock('../../src/settings/load.js', () => ({
  loadGlobalSettings: mockLoadGlobalSettings,
  loadRaceSettings: mockLoadFlowSettings,
}));

import { ok } from 'neverthrow';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { defineRace } from '../../src/race/define.js';
import { runner } from '../../src/race/runner.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { NoProviderConfiguredError } from '../../src/errors.js';
import { z } from '../../src/zod.js';
import type { InvocationResponse } from '../../src/providers/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const canned: InvocationResponse = {
  text: '{}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function singleStepFlow() {
  return defineRace({
    name: 'resolution-test',
    version: '0.1.0',
    input: z.object({}),
    runners: {
      only: runner.prompt({
        promptFile: 'p.md',
        output: { baton: 'result' },
      }),
    },
  });
}

function makeMockRegistry(): ProviderRegistry {
  const provider = new MockProvider({ responses: { only: canned } });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Runner — provider resolution', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-prov-res-'));
    await writeFile(join(tmp, 'p.md'), '# test', 'utf8');
    mockLoadGlobalSettings.mockReset();
    mockLoadFlowSettings.mockReset();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[PROV-RES-001] flagProvider wins over flow and global settings', async () => {
    // Both settings layers would produce a different (nonexistent) provider,
    // but the flag always wins.
    mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'nonexistent-global' }));
    mockLoadFlowSettings.mockResolvedValue(ok({ provider: 'nonexistent-flow' }));

    const registry = makeMockRegistry();
    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    const result = await orchestrator.run(
      singleStepFlow(),
      {},
      { flagProvider: 'mock', raceDir: tmp, authTimeoutMs: 1000 },
    );

    expect(result.status).toBe('succeeded');
  });

  it('[PROV-RES-002] flow settings win over global settings when no flag', async () => {
    // Flow says 'mock'; global says something that doesn't exist.
    mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'nonexistent-global' }));
    mockLoadFlowSettings.mockResolvedValue(ok({ provider: 'mock' }));

    const registry = makeMockRegistry();
    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    const result = await orchestrator.run(
      singleStepFlow(),
      {},
      { raceDir: tmp, authTimeoutMs: 1000 },
    );

    expect(result.status).toBe('succeeded');
  });

  it('[PROV-RES-003] global settings used when no flag and no flow settings provider', async () => {
    // Flow settings has no provider; global has 'mock'.
    mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'mock' }));
    mockLoadFlowSettings.mockResolvedValue(ok(null));

    const registry = makeMockRegistry();
    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    const result = await orchestrator.run(
      singleStepFlow(),
      {},
      { raceDir: tmp, authTimeoutMs: 1000 },
    );

    expect(result.status).toBe('succeeded');
  });

  it('[PROV-RES-004] no provider anywhere throws NoProviderConfiguredError before any step runs', async () => {
    // Neither layer has a provider.
    mockLoadGlobalSettings.mockResolvedValue(ok(null));
    mockLoadFlowSettings.mockResolvedValue(ok(null));

    const registry = makeMockRegistry();
    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });

    await expect(
      orchestrator.run(singleStepFlow(), {}, { raceDir: tmp, authTimeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(NoProviderConfiguredError);
  });
});
