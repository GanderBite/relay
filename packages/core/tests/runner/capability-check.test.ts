/**
 * Sprint 5 task_32 contract tests for capability negotiation.
 * References packages/core/src/runner/capability-check.ts — not yet implemented.
 */
import { describe, it, expect } from 'vitest';

import {
  checkCapabilities,
  resolveProvider,
} from '../../src/runner/capability-check.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderCapabilityError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { z } from '../../src/zod.js';

function makeFlow(build: () => Parameters<typeof defineFlow>[0]) {
  return defineFlow(build())._unsafeUnwrap();
}

describe('capability-check', () => {
  it('[CAP-001] rejects a prompt step with output.schema on structuredOutput:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { structuredOutput: false },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step
          .prompt({
            promptFile: 'p.md',
            output: { handoff: 'x', schema: z.object({ y: z.string() }) },
          })
          ._unsafeUnwrap(),
      },
    }));

    expect(() => checkCapabilities(flow, registry, 'mock')).toThrow(ProviderCapabilityError);
  });

  it('[CAP-002] rejects step requesting a tool the provider does not advertise', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { tools: true, builtInTools: ['Read', 'Grep'] },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step
          .prompt({
            promptFile: 'p.md',
            tools: ['Read', 'UnknownTool'],
            output: { handoff: 'x' },
          })
          ._unsafeUnwrap(),
      },
    }));

    expect(() => checkCapabilities(flow, registry, 'mock')).toThrow(/UnknownTool/);
  });

  it('[CAP-003] rejects an unknown model when provider.models is non-empty', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { models: ['sonnet'] },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step
          .prompt({ promptFile: 'p.md', model: 'opus', output: { handoff: 'x' } })
          ._unsafeUnwrap(),
      },
    }));

    expect(() => checkCapabilities(flow, registry, 'mock')).toThrow(/opus/);
  });

  it('[CAP-004] rejects maxBudgetUsd on a budgetCap:false provider', () => {
    const provider = new MockProvider({
      responses: {},
      capabilities: { budgetCap: false },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps: {
        a: step
          .prompt({
            promptFile: 'p.md',
            maxBudgetUsd: 1.0,
            output: { handoff: 'x' },
          })
          ._unsafeUnwrap(),
      },
    }));

    expect(() => checkCapabilities(flow, registry, 'mock')).toThrow(/budget/i);
  });

  it('[CAP-005] resolveProvider precedence: step > flow > runner default', () => {
    const stepProv = new MockProvider({ responses: {} });
    (stepProv as unknown as { name: string }).name = 'stepProv';
    const flowProv = new MockProvider({ responses: {} });
    (flowProv as unknown as { name: string }).name = 'flowProv';
    const runnerProv = new MockProvider({ responses: {} });
    (runnerProv as unknown as { name: string }).name = 'runnerProv';

    const registry = new ProviderRegistry();
    registry.register(stepProv);
    registry.register(flowProv);
    registry.register(runnerProv);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      defaultProvider: 'flowProv',
      input: z.object({}),
      steps: {
        a: step
          .prompt({
            promptFile: 'p.md',
            provider: 'stepProv',
            output: { handoff: 'x' },
          })
          ._unsafeUnwrap(),
      },
    }));

    const resolved = resolveProvider(flow.steps.a, flow, { defaultProvider: 'runnerProv', providers: registry });
    expect(resolved).toBe(stepProv);
  });

  it('[CAP-006] resolveProvider falls back to runner default when step + flow omit', () => {
    const claudeLike = new MockProvider({ responses: {} });
    (claudeLike as unknown as { name: string }).name = 'claude';
    const registry = new ProviderRegistry();
    registry.register(claudeLike);

    const flow = makeFlow(() => ({
      name: 'f',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        a: step.prompt({ promptFile: 'p.md', output: { handoff: 'x' } })._unsafeUnwrap(),
      },
    }));

    const resolved = resolveProvider(flow.steps.a, flow, { defaultProvider: 'claude', providers: registry });
    expect(resolved).toBe(claudeLike);
  });
});
