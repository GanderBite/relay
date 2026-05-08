import { defineFlow, step, z } from '@ganderbite/relay-core';

/**
 * Schema for the review handoff. The loop terminates when `decision` equals
 * `'done'`; otherwise the body re-runs and the implement step reads the prior
 * `feedback` from this handoff.
 */
export const ReviewSchema = z.object({
  decision: z.enum(['continue', 'done']),
  feedback: z.string().optional(),
});

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Iterative implement-review loop: implement reads optional prior review feedback, review decides continue or done.',
  input: z.object({
    task: z.string().describe('The task to implement.'),
  }),
  steps: {
    fix_loop: step.loop({
      body: {
        implement: step.prompt({
          promptFile: 'prompts/01_implement.md',
          contextFrom: ['review?'],
          output: { handoff: 'implementation' },
        }),
        review: step.prompt({
          promptFile: 'prompts/02_review.md',
          dependsOn: ['implement'],
          contextFrom: ['implementation'],
          output: { handoff: 'review', schema: ReviewSchema },
        }),
      },
      until: { from: 'review', when: { decision: 'done' } },
      maxIterations: 5,
    }),
  },
});
