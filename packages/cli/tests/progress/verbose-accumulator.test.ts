/**
 * Regression test for the verbose-mode token accumulator += fix.
 *
 * Feeds multiple `usage` event records to ProgressRenderer via the public
 * onEvent() path and asserts the accumulator sums (not replaces) tokensIn
 * and tokensOut across records.
 */

import type { Flow } from '@ganderbite/relay-core';
import { describe, expect, it } from 'vitest';
import { ProgressRenderer } from '../../src/progress/render/index.js';
import type { AuthInfo } from '../../src/progress/render/types.js';

/** Minimal Flow fixture that satisfies the graph.topoOrder iteration in start(). */
function makeMinimalFlow(stepIds: string[]): Flow<unknown> {
  return {
    name: 'test-flow',
    version: '0.0.1',
    input: { parse: (v: unknown) => v } as never,
    steps: Object.fromEntries(
      stepIds.map((id) => [
        id,
        { kind: 'prompt' as const, id, promptFile: 'p.md', output: { artifact: 'out.txt' } },
      ]),
    ),
    start: stepIds[0],
    graph: {
      topoOrder: stepIds,
      rootSteps: stepIds.slice(0, 1),
      entry: stepIds[0] ?? '',
      successors: new Map(stepIds.map((id) => [id, new Set<string>()])),
      predecessors: new Map(stepIds.map((id) => [id, new Set<string>()])),
    },
    rootSteps: stepIds.slice(0, 1),
  } as unknown as Flow<unknown>;
}

const AUTH: AuthInfo = { label: 'subscription', estUsd: 0 };

/** Build a minimal ReplayedEventRecord for a usage event. */
function usageRecord(inputTokens?: number, outputTokens?: number) {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    attempt: 1,
    event: {
      type: 'usage' as const,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    },
  };
}

describe('ProgressRenderer verbose accumulator', () => {
  it('sums tokensIn and tokensOut across two usage records (not replaces)', () => {
    const flow = makeMinimalFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, AUTH, /* verbose= */ true);
    renderer.start('run-001');

    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(10, 100)],
    });

    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(5, 50)],
    });

    const acc = renderer.getVerboseAccumulatorForTest('step-a');
    expect(acc).toBeDefined();
    expect(acc!.tokensIn).toBe(15);
    expect(acc!.tokensOut).toBe(150);

    renderer.stop();
  });

  it('contributes 0 for a missing field in a subsequent usage record', () => {
    const flow = makeMinimalFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, AUTH, /* verbose= */ true);
    renderer.start('run-002');

    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(20, 80)],
    });

    // Third record: only outputTokens present — inputTokens contributes 0
    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(undefined, 0)],
    });

    const acc = renderer.getVerboseAccumulatorForTest('step-a');
    expect(acc).toBeDefined();
    expect(acc!.tokensIn).toBe(20); // 20 + 0 = 20
    expect(acc!.tokensOut).toBe(80); // 80 + 0 = 80

    renderer.stop();
  });

  it('returns undefined for a step that received no events', () => {
    const flow = makeMinimalFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, AUTH, /* verbose= */ true);
    renderer.start('run-003');

    const acc = renderer.getVerboseAccumulatorForTest('step-a');
    expect(acc).toBeUndefined();

    renderer.stop();
  });

  it('returns undefined when verbose mode is off', () => {
    const flow = makeMinimalFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, AUTH, /* verbose= */ false);
    renderer.start('run-004');

    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(10, 100)],
    });

    // With verbose=false, #verboseAccumulators is null, so nothing is stored.
    const acc = renderer.getVerboseAccumulatorForTest('step-a');
    expect(acc).toBeUndefined();

    renderer.stop();
  });

  it('accumulates across a batch of records fed in a single onEvent call', () => {
    const flow = makeMinimalFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, AUTH, /* verbose= */ true);
    renderer.start('run-005');

    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [usageRecord(3, 30), usageRecord(7, 70)],
    });

    const acc = renderer.getVerboseAccumulatorForTest('step-a');
    expect(acc).toBeDefined();
    expect(acc!.tokensIn).toBe(10); // 3 + 7
    expect(acc!.tokensOut).toBe(100); // 30 + 70

    renderer.stop();
  });
});
