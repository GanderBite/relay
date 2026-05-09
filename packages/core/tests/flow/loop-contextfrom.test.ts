import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { z } from '../../src/zod.js';

describe('loop body contextFrom error messages', () => {
  it('[LOOP-CTX-001] contextFrom referencing a handoff inside a loop body emits dotted-notation hint', () => {
    // 'step-b' tries to reference 'review' which is produced inside the body
    // of 'review-loop'. The compiler must detect this and emit an error that
    // names the full dotted address 'review-loop.review'.
    expect(() => {
      defineFlow({
        name: 'ctx-loop-test',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          'review-loop': step.loop({
            body: {
              review: step.prompt({
                promptFile: 'review.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
          'step-b': step.prompt({
            promptFile: 'b.md',
            dependsOn: ['review-loop'],
            contextFrom: ['review'],
            output: { handoff: 'b-out' },
          }),
        },
      });
    }).toThrow(FlowDefinitionError);

    // Re-run to capture the error message.
    let caught: FlowDefinitionError | undefined;
    try {
      defineFlow({
        name: 'ctx-loop-test',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          'review-loop': step.loop({
            body: {
              review: step.prompt({
                promptFile: 'review.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
          'step-b': step.prompt({
            promptFile: 'b.md',
            dependsOn: ['review-loop'],
            contextFrom: ['review'],
            output: { handoff: 'b-out' },
          }),
        },
      });
    } catch (e) {
      caught = e as FlowDefinitionError;
    }

    expect(caught).toBeInstanceOf(FlowDefinitionError);
    const msg = caught!.message;
    // The message must name the handoff and the loop step.
    expect(msg).toContain('review');
    expect(msg).toContain('review-loop');
    // The dotted-notation address must appear in the message.
    expect(msg).toContain('review-loop.review');
    // The message must not fall through to the generic 'unknown handoff' path.
    expect(msg).not.toMatch(/unknown handoff/i);
  });

  it('[LOOP-CTX-002] contextFrom referencing a truly unknown handoff still emits the generic error', () => {
    // 'missing' is not produced anywhere — not in a loop body and not by any
    // outer step. The compiler must fall through to the generic 'unknown
    // handoff' error, NOT the dotted-notation hint.
    expect(() => {
      defineFlow({
        name: 'ctx-unknown-test',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          'review-loop': step.loop({
            body: {
              review: step.prompt({
                promptFile: 'review.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
          'step-b': step.prompt({
            promptFile: 'b.md',
            dependsOn: ['review-loop'],
            contextFrom: ['missing'],
            output: { handoff: 'b-out' },
          }),
        },
      });
    }).toThrow(FlowDefinitionError);

    let caught: FlowDefinitionError | undefined;
    try {
      defineFlow({
        name: 'ctx-unknown-test',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          'review-loop': step.loop({
            body: {
              review: step.prompt({
                promptFile: 'review.md',
                output: { handoff: 'review' },
              }),
            },
            until: { from: 'review', when: { decision: 'done' } },
            maxIterations: 5,
          }),
          'step-b': step.prompt({
            promptFile: 'b.md',
            dependsOn: ['review-loop'],
            contextFrom: ['missing'],
            output: { handoff: 'b-out' },
          }),
        },
      });
    } catch (e) {
      caught = e as FlowDefinitionError;
    }

    expect(caught).toBeInstanceOf(FlowDefinitionError);
    const msg = caught!.message;
    // The generic error must name the unknown handoff.
    expect(msg).toContain('missing');
    expect(msg).toContain('step-b');
    // Must not emit the loop-body dotted-notation hint for a truly unknown handoff.
    expect(msg).not.toContain('review-loop.missing');
    // Must contain the generic 'unknown handoff' language.
    expect(msg).toMatch(/unknown handoff/i);
  });
});
