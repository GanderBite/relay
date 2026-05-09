import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { buildGraph } from '../../src/flow/graph.js';
import { step } from '../../src/flow/step.js';
import type { LoopStepBuilderInput } from '../../src/flow/steps/loop.js';
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

  describe('loop start field — body entry resolution', () => {
    it('[LOOP-013] multi-root body with start set resolves entry to the named step', () => {
      // Two independent body steps (no dependsOn) — two roots. `start` picks
      // one as the entry so the graph compiler does not throw.
      // `until.from` must match the handoff name of at least one body step.
      const flow = defineFlow({
        name: 'start-field-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              step_a: step.prompt({
                promptFile: 'a.md',
                output: { handoff: 'a_out' },
              }),
              step_b: step.prompt({
                promptFile: 'b.md',
                output: { handoff: 'b_out' },
              }),
            },
            until: { from: 'b_out', when: { decision: 'done' } },
            maxIterations: 3,
            start: 'step_b',
          }),
        },
      });

      const loopStep = flow.steps['fix_loop'] as LoopStep;
      expect(loopStep.bodyGraph).toBeDefined();
      // The declared `start` step must be the graph entry.
      expect(loopStep.bodyGraph?.entry).toBe('step_b');
    });

    it('[LOOP-014] single-root body without start resolves entry to the sole root', () => {
      // A body with a single step that has no dependsOn — one root, no `start`
      // needed. Entry must equal the only root.
      const flow = defineFlow({
        name: 'single-root-flow',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fix_loop: step.loop({
            body: {
              review: step.prompt({
                promptFile: 'r.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 2,
          }),
        },
      });

      const loopStep = flow.steps['fix_loop'] as LoopStep;
      expect(loopStep.bodyGraph).toBeDefined();
      expect(loopStep.bodyGraph?.entry).toBe('review');
    });

    it('[LOOP-015] multi-root body without start throws FlowDefinitionError', () => {
      // Two independent body steps produce two roots. Without `start` the
      // graph compiler cannot pick an entry and must throw FlowDefinitionError.
      expect(() => {
        defineFlow({
          name: 'ambiguous-entry-flow',
          version: '0.0.1',
          input: z.object({}),
          steps: {
            fix_loop: step.loop({
              body: {
                step_a: step.prompt({
                  promptFile: 'a.md',
                  output: { handoff: 'a_out' },
                }),
                step_b: step.prompt({
                  promptFile: 'b.md',
                  output: { handoff: 'b_out' },
                }),
              },
              until: { from: 'b_out', when: { decision: 'done' } },
              maxIterations: 3,
              // No `start` — should trigger FlowDefinitionError.
            }),
          },
        });
      }).toThrow(FlowDefinitionError);
    });
  });

  describe('LoopStepBuilderInput body type — no as-never cast required', () => {
    it('[LOOP-016] scriptStep value is directly assignable to the body map', () => {
      // This test is intentionally type-level: constructing the object without
      // `as never` on the script step value must compile. The runtime assertion
      // confirms the builder runs successfully without a type cast work-around.
      const bodyMap: LoopStepBuilderInput['body'] = {
        run_check: step.script({ run: ['echo', 'hi'] }),
      };

      // Runtime sanity: the body map contains the script step builder output.
      expect(bodyMap['run_check']).toBeDefined();
      expect(bodyMap['run_check']?.kind).toBe('script');
    });
  });
});
