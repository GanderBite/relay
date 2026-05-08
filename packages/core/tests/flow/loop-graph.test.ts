import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { buildGraph } from '../../src/flow/graph.js';
import { step } from '../../src/flow/step.js';
import type { LoopStep, Step } from '../../src/flow/types.js';
import { z } from '../../src/zod.js';

describe('loop graph compiler', () => {
  it('[LOOP-011] graph compiler attaches bodyGraph after defineFlow', () => {
    const flow = defineFlow({
      name: 'fix-flow',
      version: '0.0.1',
      input: z.object({}),
      steps: {
        fix_loop: step.loop({
          body: {
            implement: step.prompt({
              promptFile: 'p.md',
              output: { handoff: 'implementation' },
            }),
            review: step.prompt({
              promptFile: 'p.md',
              output: { handoff: 'review' },
              dependsOn: ['implement'],
            }),
          },
          until: { from: 'review', when: { decision: 'done' } },
          maxIterations: 5,
        }),
      },
    });

    const loopStep = flow.steps['fix_loop'] as LoopStep;

    // The bodyGraph field must be defined after defineFlow compiles the loop.
    expect(loopStep).toBeDefined();
    expect(loopStep.kind).toBe('loop');
    expect(loopStep.bodyGraph).toBeDefined();

    const bodyGraph = loopStep.bodyGraph;
    if (bodyGraph === undefined) throw new Error('bodyGraph must be populated by the compiler');

    const { topoOrder } = bodyGraph;
    expect(topoOrder).toContain('implement');
    expect(topoOrder).toContain('review');

    expect(topoOrder.indexOf('implement')).toBeLessThan(topoOrder.indexOf('review'));

    expect(bodyGraph.successors.has('implement')).toBe(true);
    expect(bodyGraph.predecessors.has('review')).toBe(true);
  });

  it('[LOOP-012] buildGraph rejects loop body with a cycle', () => {
    // Construct loop step body steps that have a cycle. The step.loop builder
    // calls buildBodyGraph which runs kahnTopoSort over the body — a cycle
    // in the body must produce a FlowDefinitionError via err().

    // Use buildGraph directly to test body graph compilation via buildGraph
    // with a cycle in the steps map.
    const cycleBody: Record<string, Step> = {
      implement: {
        id: 'implement',
        kind: 'prompt',
        promptFile: 'p.md',
        output: { handoff: 'implementation' },
        dependsOn: ['review'],
      },
      review: {
        id: 'review',
        kind: 'prompt',
        promptFile: 'p.md',
        output: { handoff: 'review' },
        dependsOn: ['implement'],
      },
    };

    const result = buildGraph(cycleBody);
    expect(result.isErr()).toBe(true);
    const err = result._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect(err.message).toMatch(/cycle/i);

    // Also verify that defineFlow with this cyclic body throws FlowDefinitionError.
    expect(() => {
      defineFlow({
        name: 'fix-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              implement: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'implementation' },
                dependsOn: ['review'],
              }),
              review: step.prompt({
                promptFile: 'p.md',
                output: { handoff: 'review' },
                dependsOn: ['implement'],
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
        },
      });
    }).toThrow(FlowDefinitionError);
  });
});
