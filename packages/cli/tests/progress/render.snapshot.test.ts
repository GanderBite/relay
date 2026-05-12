import type { Flow } from '@ganderbite/relay-core';
import { z } from '@ganderbite/relay-core';
import { describe, expect, it } from 'vitest';
import { renderFooter } from '../../src/progress/render/footer.js';
import { renderLoopRow } from '../../src/progress/render/loop-row.js';
import { renderParallelRow } from '../../src/progress/render/parallel-row.js';
import { renderStepRow } from '../../src/progress/render/step-row.js';
import type { StepDisplayState } from '../../src/progress/render/types.js';

// Fixed past timestamp so elapsed columns are non-empty and deterministic.
const T0 = new Date(Date.now() - 5000).toISOString();
const SF = 0; // spinnerFrame

function makeFlow(stepIds: string[]): Flow<unknown> {
  const steps: Record<string, { dependsOn: readonly string[]; promptFile: string }> = {};
  for (const id of stepIds) steps[id] = { dependsOn: [], promptFile: 'p.md' };
  return {
    name: 'test-flow',
    version: '1.0.0',
    input: z.object({}),
    steps,
    rootSteps: stepIds.slice(0, 1),
    graph: {
      successors: new Map(),
      predecessors: new Map(),
      topoOrder: stepIds,
      rootSteps: stepIds.slice(0, 1),
      entry: stepIds[0] ?? '',
    },
  } as unknown as Flow<unknown>;
}

function makeState(overrides: Partial<StepDisplayState> = {}): StepDisplayState {
  return {
    id: 'step-a',
    dependsOn: [],
    live: null,
    runningStartedAt: null,
    finalDurationMs: null,
    finalTokensIn: null,
    finalTokensOut: null,
    finalCostUsd: null,
    finalModel: null,
    ...overrides,
  };
}

function runningLive(extra: object = {}) {
  return { status: 'running' as const, attempt: 1, startedAt: T0, lastUpdateAt: T0, ...extra };
}

function succeededLive(extra: object = {}) {
  return { status: 'succeeded' as const, attempt: 1, startedAt: T0, lastUpdateAt: T0, ...extra };
}

function failedLive(extra: object = {}) {
  return { status: 'failed' as const, attempt: 1, startedAt: T0, lastUpdateAt: T0, ...extra };
}

// ---------------------------------------------------------------------------
// renderStepRow
// ---------------------------------------------------------------------------

describe('renderStepRow', () => {
  it('pending with deps shows "waiting on <dep>"', () => {
    const dep = makeState({ id: 'dep-step', live: null });
    const state = makeState({ id: 'step-a', dependsOn: ['dep-step'], live: null });
    const steps = new Map([
      ['step-a', state],
      ['dep-step', dep],
    ]);
    const row = renderStepRow(state, SF, steps, makeFlow(['dep-step', 'step-a']), false, null);
    expect(row).toContain('waiting on dep-step');
  });

  it('running with 3 tools and 226 tokens contains "3 tools" and "226"', () => {
    const state = makeState({
      id: 'step-a',
      runningStartedAt: T0,
      live: runningLive({ toolsSoFar: 3, tokensSoFar: 226 }),
    });
    const row = renderStepRow(
      state,
      SF,
      new Map([['step-a', state]]),
      makeFlow(['step-a']),
      false,
      null,
    );
    expect(row).toContain('3 tools');
    expect(row).toContain('226');
  });

  it('running row does NOT contain the model string', () => {
    const state = makeState({
      id: 'step-a',
      runningStartedAt: T0,
      live: runningLive({ model: 'claude-sonnet-4-5', toolsSoFar: 3, tokensSoFar: 226 }),
    });
    const row = renderStepRow(
      state,
      SF,
      new Map([['step-a', state]]),
      makeFlow(['step-a']),
      false,
      null,
    );
    expect(row).not.toContain('claude-sonnet-4-5');
    expect(row).not.toContain('sonnet');
  });

  it('running with 0 tools contains "0 tools"', () => {
    const state = makeState({
      id: 'step-a',
      runningStartedAt: T0,
      live: runningLive({ toolsSoFar: 0, tokensSoFar: 0 }),
    });
    const row = renderStepRow(
      state,
      SF,
      new Map([['step-a', state]]),
      makeFlow(['step-a']),
      false,
      null,
    );
    expect(row).toContain('0 tools');
  });

  it('succeeded with final metrics contains tool count, duration and step tokens', () => {
    const state = makeState({
      id: 'step-a',
      runningStartedAt: T0,
      finalDurationMs: 3200,
      finalTokensIn: 100,
      finalTokensOut: 50,
      finalCostUsd: 0,
      finalModel: 'mock',
      live: succeededLive({ toolsSoFar: 5, tokensSoFar: 150 }),
    });
    const row = renderStepRow(
      state,
      SF,
      new Map([['step-a', state]]),
      makeFlow(['step-a']),
      false,
      null,
    );
    expect(row).toContain('5 tools');
    expect(row).toContain('150'); // finalTokensIn + finalTokensOut = 150
    expect(row).toContain('3.2s');
  });

  it('failed step row contains the fail symbol', () => {
    const state = makeState({
      id: 'step-a',
      runningStartedAt: T0,
      finalDurationMs: 1000,
      finalTokensIn: 0,
      finalTokensOut: 0,
      finalCostUsd: 0,
      finalModel: 'mock',
      live: failedLive({ toolsSoFar: 0, tokensSoFar: 0 }),
    });
    const row = renderStepRow(
      state,
      SF,
      new Map([['step-a', state]]),
      makeFlow(['step-a']),
      false,
      null,
    );
    expect(row).toContain('✕');
  });
});

// ---------------------------------------------------------------------------
// renderFooter
// ---------------------------------------------------------------------------

describe('renderFooter', () => {
  it('contains "elapsed", "tokens", and "ctrl-c saves state"', () => {
    const footer = renderFooter(T0, 500);
    expect(footer).toContain('elapsed');
    expect(footer).toContain('tokens');
    expect(footer).toContain('ctrl-c saves state');
  });

  it('12300 tokens renders as "12.3K"', () => {
    expect(renderFooter(T0, 12300)).toContain('12.3K');
  });

  it('does NOT contain "est" or "spent"', () => {
    const footer = renderFooter(T0, 1000);
    expect(footer).not.toContain('est');
    expect(footer).not.toContain('spent');
  });

  it('empty startedAt shows 00:00 elapsed', () => {
    expect(renderFooter('', 0)).toContain('00:00');
  });
});

// ---------------------------------------------------------------------------
// renderLoopRow
// ---------------------------------------------------------------------------

describe('renderLoopRow', () => {
  function mkLoopFixture(
    iter: number,
    maxIter: number,
    bodyLive: ReturnType<typeof runningLive> | ReturnType<typeof failedLive>,
  ) {
    const loopState = makeState({
      id: 'my-loop',
      runningStartedAt: T0,
      live: runningLive({ iter, maxIter }),
    });
    const bodyState = makeState({ id: 'body-step', live: bodyLive });
    const bodyStates = new Map([['body-step', bodyState]]);
    const flow = makeFlow(['my-loop', 'body-step']);
    return { loopState, bodyStates, flow };
  }

  it('running loop at iter 3/10: parent row contains "iter 3/10"', () => {
    const { loopState, bodyStates, flow } = mkLoopFixture(
      3,
      10,
      runningLive({ toolsSoFar: 1, tokensSoFar: 50 }),
    );
    const output = renderLoopRow(
      'my-loop',
      loopState,
      bodyStates,
      ['body-step'],
      SF,
      flow,
      false,
      null,
    );
    expect(output).toContain('iter 3/10');
  });

  it('body step row is prefixed with 4 spaces', () => {
    const { loopState, bodyStates, flow } = mkLoopFixture(
      1,
      5,
      runningLive({ toolsSoFar: 0, tokensSoFar: 0 }),
    );
    const output = renderLoopRow(
      'my-loop',
      loopState,
      bodyStates,
      ['body-step'],
      SF,
      flow,
      false,
      null,
    );
    const lines = output.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/^ {4}/);
  });

  it('failed body step row contains the fail symbol', () => {
    const { loopState, bodyStates, flow } = mkLoopFixture(
      2,
      5,
      failedLive({ toolsSoFar: 0, tokensSoFar: 0 }),
    );
    // Override body state with final metrics so failed branch renders correctly
    const failedBody = makeState({
      id: 'body-step',
      runningStartedAt: T0,
      finalDurationMs: 500,
      finalTokensIn: 0,
      finalTokensOut: 0,
      finalCostUsd: 0,
      finalModel: 'mock',
      live: failedLive({ toolsSoFar: 0, tokensSoFar: 0 }),
    });
    bodyStates.set('body-step', failedBody);
    const output = renderLoopRow(
      'my-loop',
      loopState,
      bodyStates,
      ['body-step'],
      SF,
      flow,
      false,
      null,
    );
    expect(output).toContain('✕');
  });
});

// ---------------------------------------------------------------------------
// renderParallelRow
// ---------------------------------------------------------------------------

describe('renderParallelRow', () => {
  function mkBranch(id: string, extra: object = {}): StepDisplayState {
    return makeState({
      id,
      live: runningLive({ toolsSoFar: 0, tokensSoFar: 10, ...extra }),
    });
  }

  it('3 running branches: parent row contains "3 branches"', () => {
    const parallelState = makeState({
      id: 'par-step',
      runningStartedAt: T0,
      live: runningLive({ branchCount: 3 }),
    });
    const branchIds = ['branch-1', 'branch-2', 'branch-3'];
    const branchStates = new Map(branchIds.map((id) => [id, mkBranch(id)]));
    const output = renderParallelRow(
      'par-step',
      parallelState,
      branchStates,
      branchIds,
      SF,
      makeFlow(['par-step', ...branchIds]),
      false,
      null,
    );
    expect(output).toContain('3 branches');
  });

  it('3 running branches: each branch row is prefixed with 4 spaces', () => {
    const parallelState = makeState({
      id: 'par-step',
      runningStartedAt: T0,
      live: runningLive({ branchCount: 3 }),
    });
    const branchIds = ['branch-1', 'branch-2', 'branch-3'];
    const branchStates = new Map(branchIds.map((id) => [id, mkBranch(id)]));
    const output = renderParallelRow(
      'par-step',
      parallelState,
      branchStates,
      branchIds,
      SF,
      makeFlow(['par-step', ...branchIds]),
      false,
      null,
    );
    const lines = output.split('\n');
    expect(lines.length).toBe(4); // 1 parent + 3 branches
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^ {4}/);
    }
  });

  it('all branches succeeded: parent row shows succeeded symbol and branch token totals', () => {
    const parallelState = makeState({
      id: 'par-step',
      runningStartedAt: T0,
      finalDurationMs: 5000,
      finalTokensIn: 200,
      finalTokensOut: 100,
      finalCostUsd: 0,
      finalModel: 'mock',
      live: succeededLive({ branchCount: 2 }),
    });
    const mkSucceeded = (id: string): StepDisplayState =>
      makeState({
        id,
        runningStartedAt: T0,
        finalDurationMs: 2000,
        finalTokensIn: 100,
        finalTokensOut: 50,
        finalCostUsd: 0,
        finalModel: 'mock',
        live: succeededLive({ toolsSoFar: 1, tokensSoFar: 150 }),
      });
    const branchIds = ['branch-a', 'branch-b'];
    const branchStates = new Map(branchIds.map((id) => [id, mkSucceeded(id)]));
    const output = renderParallelRow(
      'par-step',
      parallelState,
      branchStates,
      branchIds,
      SF,
      makeFlow(['par-step', ...branchIds]),
      false,
      null,
    );
    expect(output).toContain('✓');
    // Branch token totals: 2 × (100 + 50) = 300
    expect(output).toContain('300');
  });
});
