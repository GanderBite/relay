import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { buildGraph } from '../../src/flow/graph.js';
import type {
  BranchStep,
  ParallelStep,
  PromptStep,
  ScriptStep,
  Step,
  TerminalStep,
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
      const cyclePath = err.details?.cyclePath;
      expect(Array.isArray(cyclePath)).toBe(true);
      const cycleArr = cyclePath as string[];
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
      const cyclePath = result._unsafeUnwrapErr().details?.cyclePath as string[];
      expect(cyclePath.length).toBe(4);
      const distinct = new Set(cyclePath);
      expect(distinct.size).toBe(3);
      expect(cyclePath[0]).toBe(cyclePath[3]);
    });

    it('[DAG-004] self-dependency is rejected as a cycle', () => {
      const steps: Record<string, Step> = {
        loop: promptStep('loop', { dependsOn: ['loop'] }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('cycle detected');
      const cyclePath = result._unsafeUnwrapErr().details?.cyclePath as string[];
      expect(cyclePath).toContain('loop');
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

    it('[DAG-015] fan-in barrier: branches in both dependsOn and branches does not produce a cycle', () => {
      // prep → branch_a ─┐
      //      → branch_b ─┼─▶ barrier ──▶ merge
      //
      // barrier.dependsOn and barrier.branches both list branch_a and branch_b.
      // This is the canonical fan-in pattern; no cycle should be reported.
      const steps: Record<string, Step> = {
        prep: promptStep('prep', { output: { handoff: 'prep' } }),
        branch_a: promptStep('branch_a', {
          dependsOn: ['prep'],
          contextFrom: ['prep'],
          output: { handoff: 'branch_a' },
        }),
        branch_b: promptStep('branch_b', {
          dependsOn: ['prep'],
          contextFrom: ['prep'],
          output: { handoff: 'branch_b' },
        }),
        barrier: parallelStep('barrier', ['branch_a', 'branch_b'], {
          dependsOn: ['branch_a', 'branch_b'],
        }),
        merge: promptStep('merge', {
          dependsOn: ['barrier'],
          contextFrom: ['prep', 'branch_a', 'branch_b'],
          output: { artifact: 'merged.md' },
        }),
      };
      const result = buildGraph(steps, 'prep');
      expect(result.isOk()).toBe(true);
      const graph = result._unsafeUnwrap();
      // barrier must come after both branches in topo order
      const order = graph.topoOrder;
      expect(order.indexOf('prep')).toBeLessThan(order.indexOf('branch_a'));
      expect(order.indexOf('prep')).toBeLessThan(order.indexOf('branch_b'));
      expect(order.indexOf('branch_a')).toBeLessThan(order.indexOf('barrier'));
      expect(order.indexOf('branch_b')).toBeLessThan(order.indexOf('barrier'));
      expect(order.indexOf('barrier')).toBeLessThan(order.indexOf('merge'));
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
      expect(msg).toContain('onExit');
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
          contextFrom: ['ghostBaton'],
          output: { handoff: 'b-out' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isErr()).toBe(true);
      const msg = result._unsafeUnwrapErr().message;
      expect(msg).toContain('b');
      expect(msg).toContain('ghostBaton');
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

  describe('onExit implicit dependency edges', () => {
    it('[DAG-016] branch onExit target receives an implicit predecessor edge — no dependsOn needed', () => {
      // A branch step routes to 'step-b' via onExit. The graph compiler must
      // add an edge from 'checker' to 'step-b', so 'step-b' is not a root
      // step and does not need a dependsOn declaration.
      const steps: Record<string, Step> = {
        a: promptStep('a', { output: { handoff: 'a-out' } }),
        checker: branchStep('checker', { '0': 'step-b', '1': 'abort' }),
        'step-b': promptStep('step-b', { output: { handoff: 'b-out' } }),
      };
      // checker has no dependsOn but 'a' has no successors yet — use explicit start.
      const result = buildGraph(steps, 'a');
      expect(result.isOk()).toBe(true);
      const graph = result._unsafeUnwrap();

      // 'step-b' must be a successor of 'checker' in the graph.
      expect(graph.successors.get('checker')?.has('step-b')).toBe(true);
      // 'checker' must be a predecessor of 'step-b'.
      expect(graph.predecessors.get('step-b')?.has('checker')).toBe(true);
      // 'step-b' must not be in rootSteps — it has a predecessor.
      expect(graph.rootSteps).not.toContain('step-b');
    });

    it('[DAG-017] onExit target using contextFrom on an upstream handoff is accepted', () => {
      // 'a' produces handoff 'a-out'. 'checker' depends on 'a' and routes to
      // 'step-b' via onExit. The onExit edge makes 'checker' a predecessor of
      // 'step-b', so 'a' becomes a transitive ancestor of 'step-b'
      // (a → checker → step-b). validateContextFrom must accept step-b's
      // contextFrom: ['a-out'] without error.
      const steps: Record<string, Step> = {
        a: promptStep('a', { output: { handoff: 'a-out' } }),
        checker: {
          id: 'checker',
          kind: 'branch',
          run: 'true',
          dependsOn: ['a'],
          onExit: { '0': 'step-b', '1': 'abort' },
        } satisfies BranchStep,
        'step-b': promptStep('step-b', {
          contextFrom: ['a-out'],
          output: { handoff: 'b-out' },
        }),
      };
      const result = buildGraph(steps);
      expect(result.isOk()).toBe(true);
    });
  });

  // Satisfy the unused-import checker — keep scriptStep available for future tests.
  it('scriptStep helper is wired', () => {
    const s = scriptStep('s');
    expect(s.kind).toBe('script');
  });
});
