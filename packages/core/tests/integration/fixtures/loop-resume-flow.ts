/**
 * Flow fixture for loop integration resume tests.
 *
 * Topology: fix_loop (loop: implement -> review) -> summarize
 *
 * fix_loop iterates until review.decision === 'done'. The summarize step reads
 * the final review handoff via the dotted contextFrom ref 'fix_loop.review'.
 * This fixture is imported dynamically by Orchestrator.resume() when testing
 * the loop resume path.
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'loop-resume-flow',
  version: '0.1.0',
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
      maxIterations: 10,
    }),
    summarize: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['fix_loop'],
      contextFrom: ['fix_loop.review'],
      output: { handoff: 'summary' },
    }),
  },
});

export default flow;
