import { beforeEach, describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';

function canned() {
  return {
    text: 'ok',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.001,
    durationMs: 10,
    numTurns: 1,
    model: 'mock',
    stopReason: 'end_turn',
  } as const;
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('[REGISTRY-001] register + get roundtrips a provider by name', () => {
    const p = new MockProvider({ responses: { step: canned() } });
    const reg = registry.register(p);
    expect(reg.isOk()).toBe(true);
    const got = registry.get('mock');
    expect(got.isOk()).toBe(true);
    expect(got._unsafeUnwrap()).toBe(p);
  });

  it('[REGISTRY-002] duplicate register returns err containing the provider name', () => {
    const p1 = new MockProvider({ responses: {} });
    const p2 = new MockProvider({ responses: {} });
    registry.register(p1);
    const second = registry.register(p2);
    expect(second.isErr()).toBe(true);
    const err = second._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect(err.message).toContain('mock');
  });

  it('[REGISTRY-003] registerIfAbsent does not override an existing entry', () => {
    const pA = new MockProvider({ responses: { s: canned() } });
    const pB = new MockProvider({ responses: {} });
    registry.register(pA);
    const r = registry.registerIfAbsent(pB);
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe('already-present');
    expect(registry.get('mock')._unsafeUnwrap()).toBe(pA);
  });

  it('[REGISTRY-004] get on an unknown name returns err naming the missing provider', () => {
    registry.register(new MockProvider({ responses: {} }));
    const r = registry.get('openai');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().message).toContain('openai');
  });
});
