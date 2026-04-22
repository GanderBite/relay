/**
 * Contract tests for capability negotiation.
 * References packages/core/src/orchestrator/capability-check.ts.
 */
import { describe, it, expect } from 'vitest';

import { checkCapabilities } from '../../src/orchestrator/capability-check.js';
import { resolveProvider } from '../../src/settings/resolve.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderCapabilityError } from '../../src/errors.js';
import { defineRace } from '../../src/race/define.js';
import { runner } from '../../src/race/runner.js';
import { z } from '../../src/zod.js';

function makeFlow(build: () => Parameters<typeof defineRace>[0]) {
  return defineRace(build());
}

describe('capability-check', () => {
  it('[CAP-001] rejects a prompt runner with output.schema on structuredOutput:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { structuredOutput: false },
    });

    const race = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      runners: {
        a: runner.prompt({
          promptFile: 'p.md',
          output: { baton: 'x', schema: z.object({ y: z.string() }) },
        }),
      },
    }));

    expect(() => checkCapabilities(race, provider)).toThrow(ProviderCapabilityError);
  });

  it('[CAP-002] rejects step requesting a tool the provider does not advertise', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { tools: true, builtInTools: ['Read', 'Grep'] },
    });

    const race = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      runners: {
        a: runner.prompt({
          promptFile: 'p.md',
          tools: ['Read', 'UnknownTool'],
          output: { baton: 'x' },
        }),
      },
    }));

    expect(() => checkCapabilities(race, provider)).toThrow(/UnknownTool/);
  });

  it('[CAP-003] rejects an unknown model when provider.models is non-empty', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { models: ['sonnet'] },
    });

    const race = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      runners: {
        a: runner.prompt({ promptFile: 'p.md', model: 'opus', output: { baton: 'x' } }),
      },
    }));

    expect(() => checkCapabilities(race, provider)).toThrow(/opus/);
  });

  it('[CAP-004] rejects maxBudgetUsd on a budgetCap:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { budgetCap: false },
    });

    const race = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      runners: {
        a: runner.prompt({
          promptFile: 'p.md',
          maxBudgetUsd: 1.0,
          output: { baton: 'x' },
        }),
      },
    }));

    expect(() => checkCapabilities(race, provider)).toThrow(/budget/i);
  });

  it('[CAP-005] resolveProvider uses the flag-supplied provider name', () => {
    const runnerProv = new MockProvider({ responses: {} });
    (runnerProv as unknown as { name: string }).name = 'runnerProv';

    const registry = new ProviderRegistry();
    registry.register(runnerProv);

    const resolved = resolveProvider({
      flagProvider: 'runnerProv',
      raceSettings: null,
      globalSettings: null,
      registry,
    });
    expect(resolved.isOk() && resolved.value).toBe(runnerProv);
  });

  it('[CAP-006] resolveProvider falls back to global-settings when no flag is supplied', () => {
    const claudeLike = new MockProvider({ responses: {} });
    (claudeLike as unknown as { name: string }).name = 'claude-agent-sdk';
    const registry = new ProviderRegistry();
    registry.register(claudeLike);

    const resolved = resolveProvider({
      raceSettings: null,
      globalSettings: { provider: 'claude-agent-sdk' },
      registry,
    });
    expect(resolved.isOk() && resolved.value).toBe(claudeLike);
  });
});
