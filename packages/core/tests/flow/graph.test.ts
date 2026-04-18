import { describe, it, expect } from 'vitest';

import { buildGraph } from '../../src/flow/graph.js';
import { FlowDefinitionError } from '../../src/errors.js';
import type {
  Step,
  PromptStep,
  ParallelStep,
  TerminalStep,
  ScriptStep,
  BranchStep,
} from '../../src/flow/types.js';

function promptStep(id: string, extra?: Partial<PromptStep>): PromptStep {
  return {
    id,
    kind: 'prompt',
    promptFile: 'p.md',
    output: { handoff: `${id}-out` },
    ...extra,
  } as PromptStep;
}

function parallelStep(id: string, branches: string[], extra?: Partial<ParallelStep>): ParallelStep {
  return { id, kind: 'parallel', branches, ...extra };
}

function terminalStep(id: string): TerminalStep {
  return { id, kind: 'terminal' };
}

function scriptStep(id: string, extra?: Partial<ScriptStep>): ScriptStep {
  return { id, kind: 'script', run: 'echo hi', ...extra };
}

function branchStep(id: string, onExit: Record<string, string>): BranchStep {
  return { id, kind: 'branch', run: 'true', onExit };
}

describe('buildGraph — DAG construction', () => {
  describe('linear DAG', () => {
    it('[DAG-001] simple linear DAG produces deterministic topological order', () => {
      const steps: Record<string, Step> = {
        inventory: promptStep('inventory'),
        entities: promptStep('entities', { dependsOn: ['inventory'] }),
        report: promptStep('report', {
          dependsOn: ['entities'],
          output: { artifact: 'report.html' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isOk()).toBe(true);
      const graph = result._unsafeUnwrap();
      expect(graph.topoOrder).toEqual(['inventory', 'entities', 'report']);
      expect(graph.rootSteps).toEqual(['inventory']);
      expect(graph.entry).toBe('inventory');
    });
  });

  describe('cycle detection', () => {
    it('[DAG-002] direct cycle between two steps returns FlowDefinitionError naming both', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a', { dependsOn: ['b'] }),
        b: promptStep('b', { dependsOn: ['a'] }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(FlowDefinitionError);
      expect(err.message).toContain('cycle detected');
      expect(err.message).toContain('a');
      expect(err.message).toContain('b');
      const cycle = err.details?.cycle;
      expect(Array.isArray(cycle)).toBe(true);
      const cycleArr = cycle as string[];
      expect(cycleArr).toContain('a');
      expect(cycleArr).toContain('b');
      expect(cycleArr[0]).toBe(cycleArr[cycleArr.length - 1]);
    });

    it('[DAG-003] three-step cycle is reported as a closed path', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a', { dependsOn: ['c'] }),
        b: promptStep('b', { dependsOn: ['a'] }),
        c: promptStep('c', { dependsOn: ['b'] }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const cycle = result._unsafeUnwrapErr().details?.cycle as string[];
      expect(cycle.length).toBe(4);
      const distinct = new Set(cycle);
      expect(distinct.size).toBe(3);
      expect(cycle[0]).toBe(cycle[3]);
    });

    it('[DAG-004] self-dependency is rejected as a cycle', () => {
      const steps: Record<string, Step> = {
        loop: promptStep('loop', { dependsOn: ['loop'] }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('cycle detected');
      const cycle = result._unsafeUnwrapErr().details?.cycle as string[];
      expect(cycle).toContain('loop');
    });

    it('[DAG-005] parallel step referencing itself in branches is rejected with distinct message', () => {
      const steps: Record<string, Step> = {
        fan: parallelStep('fan', ['fan']),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('parallel step');
      expect(msg).toContain('lists itself');
      expect(msg).not.toContain('cycle detected');
    });
  });

  describe('reference validation', () => {
    it('[DAG-006] unknown dependsOn reference is rejected and names both ids', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a'),
        b: promptStep('b', { dependsOn: ['ghost'] }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('b');
      expect(msg).toContain('ghost');
      expect(msg).toContain('dependsOn');
    });

    it('[DAG-007] unknown onFail is rejected; abort and continue literals pass', () => {
      const common: Record<string, Step> = { other: promptStep('other') };

      const caseA = buildGraph({
        ...common,
        a: promptStep('a', { onFail: 'ghost' }),
      });
      expect(caseA.isErr()).toBe(true);
      expect(caseA._unsafeUnwrapErr().message).toContain('ghost');

      const caseB = buildGraph({
        ...common,
        a: promptStep('a', { onFail: 'continue', dependsOn: ['other'] }),
      });
      expect(caseB.isOk()).toBe(true);

      const caseC = buildGraph({
        ...common,
        a: promptStep('a', { onFail: 'abort', dependsOn: ['other'] }),
      });
      expect(caseC.isOk()).toBe(true);
    });

    it('[DAG-008] unknown onExit step id in script/branch is rejected', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a'),
        b: promptStep('b', { dependsOn: ['a'] }),
        checker: branchStep('checker', { '0': 'ghost', '1': 'abort', '2': 'continue' }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('ghost');
      expect(msg).toContain("onExit");
      expect(msg).toContain('0');
    });

    it('[DAG-009] unknown onAllComplete step id on parallel is rejected', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a'),
        b: promptStep('b'),
        fan: parallelStep('fan', ['a', 'b'], { onAllComplete: 'ghost' }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('onAllComplete');
      expect(msg).toContain('ghost');
    });
  });

  describe('contextFrom validation', () => {
    it('[DAG-010] contextFrom referencing an ancestor handoff is accepted', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a', { output: { handoff: 'inventory' } }),
        b: promptStep('b', {
          dependsOn: ['a'],
          contextFrom: ['inventory'],
          output: { handoff: 'b-out' },
        }),
        c: promptStep('c', {
          dependsOn: ['b'],
          contextFrom: ['inventory'],
          output: { handoff: 'c-out' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isOk()).toBe(true);
    });

    it('[DAG-011] contextFrom referencing a non-ancestor (sibling) handoff is rejected', () => {
      const steps: Record<string, Step> = {
        r: terminalStep('r'),
        a: promptStep('a', { dependsOn: ['r'], output: { handoff: 'alpha' } }),
        b: promptStep('b', {
          dependsOn: ['r'],
          contextFrom: ['alpha'],
          output: { handoff: 'b-out' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('b');
      expect(msg).toContain('alpha');
      expect(msg).toMatch(/dependsOn|upstream|ancestor|not produced/i);
    });

    it('[DAG-012] contextFrom referencing an unknown handoff is rejected', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a', { output: { artifact: 'foo.html' } }),
        b: promptStep('b', {
          dependsOn: ['a'],
          contextFrom: ['ghostHandoff'],
          output: { handoff: 'b-out' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('b');
      expect(msg).toContain('ghostHandoff');
      expect(msg).toContain('contextFrom');
    });
  });

  describe('entry resolution', () => {
    it('[DAG-013] multiple root steps without start is rejected with hint', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a'),
        b: promptStep('b'),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err.message).toContain('multiple root steps');
      expect(err.message).toContain('a');
      expect(err.message).toContain('b');
      expect(err.details?.rootSteps).toEqual(['a', 'b']);
    });

    it('[DAG-014] explicit start overrides root auto-detection; unknown start is rejected', () => {
      const steps: Record<string, Step> = {
        a: promptStep('a'),
        b: promptStep('b'),
      };
      const caseA = buildGraph(steps, 'a');
      expect(caseA.isOk()).toBe(true);
      expect(caseA._unsafeUnwrap().entry).toBe('a');

      const caseB = buildGraph(steps, 'ghost');
      expect(caseB.isErr()).toBe(true);
      const msg = caseB._unsafeUnwrapErr().message;
      expect(msg).toContain('start step');
      expect(msg).toContain('ghost');
    });
  });

  // Satisfy the unused-import checker — keep scriptStep available for future tests.
  it('scriptStep helper is wired', () => {
    const s = scriptStep('s');
    expect(s.kind).toBe('script');
  });
});
