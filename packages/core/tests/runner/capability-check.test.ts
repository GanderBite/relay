/**
 * Contract tests for capability negotiation.
 * References packages/core/src/runner/capability-check.ts.
 */
import { describe, it, expect } from 'vitest';

import { checkCapabilities } from '../../src/runner/capability-check.js';
import { resolveProvider } from '../../src/settings/resolve.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderCapabilityError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { z } from '../../src/zod.js';

function makeFlow(build: () => Parameters<typeof defineFlow>[0]) {
  return defineFlow(build());
}

describe('capability-check', () => {
  it('[CAP-001] rejects a prompt step with output.schema on structuredOutput:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { structuredOutput: false },
    });

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        a: step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'x', schema: z.object({ y: z.string() }) },
        }),
      },
    }));

    expect(() => checkCapabilities(flow, provider)).toThrow(ProviderCapabilityError);
  });

  it('[CAP-002] rejects step requesting a tool the provider does not advertise', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { tools: true, builtInTools: ['Read', 'Grep'] },
    });

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        a: step.prompt({
          promptFile: 'p.md',
          tools: ['Read', 'UnknownTool'],
          output: { handoff: 'x' },
        }),
      },
    }));

    expect(() => checkCapabilities(flow, provider)).toThrow(/UnknownTool/);
  });

  it('[CAP-003] rejects an unknown model when provider.models is non-empty', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { models: ['sonnet'] },
    });

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', model: 'opus', output: { handoff: 'x' } }),
      },
    }));

    expect(() => checkCapabilities(flow, provider)).toThrow(/opus/);
  });

  it('[CAP-004] rejects maxBudgetUsd on a budgetCap:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { budgetCap: false },
    });

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        a: step.prompt({
          promptFile: 'p.md',
          maxBudgetUsd: 1.0,
          output: { handoff: 'x' },
        }),
      },
    }));

    expect(() => checkCapabilities(flow, provider)).toThrow(/budget/i);
  });

  it('[CAP-005] resolveProvider uses the flag-supplied provider name', () => {
    const runnerProv = new MockProvider({ responses: {} });
    (runnerProv as unknown as { name: string }).name = 'runnerProv';

    const registry = new ProviderRegistry();
    registry.register(runnerProv);

    const resolved = resolveProvider({
      flagProvider: 'runnerProv',
      flowSettings: null,
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
      flowSettings: null,
      globalSettings: { provider: 'claude-agent-sdk' },
      registry,
    });
    expect(resolved.isOk() && resolved.value).toBe(claudeLike);
  });
});
