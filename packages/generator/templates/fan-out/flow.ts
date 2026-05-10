/**
 * Fan-out / fan-in flow.
 *
 * Topology:
 *
 *   gather ──▶ branch_a ─┐
 *          │             ├──▶ merge
 *          └─▶ branch_b ─┘
 *
 * The `gather` step pauses the run and waits for the operator to supply a
 * focusing angle via `relay answer`. The two branch steps then run
 * concurrently against that shared answer; a `step.parallel` acts as the
 * fan-in barrier. The `merge` step waits on the barrier and reads both
 * branch handoffs.
 *
 * The ask step is placed BEFORE the parallel barrier on purpose — concurrent
 * ask steps inside parallel branches are forbidden because the orchestrator
 * cannot serialize answers from two simultaneous pauses.
 */

import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Fan-out / fan-in flow: ask the operator for a focusing angle, run two parallel branches, then merge.',
  input: z.object({
    topic: z.string().describe('The subject both branches analyze'),
  }),
  start: 'gather',
  steps: {
    gather: step.ask({
      questions: [
        {
          id: 'focus',
          kind: 'text',
          label: 'What angle should the branches focus on?',
        },
      ],
    }),
    branch_a: step.prompt({
      promptFile: 'prompts/02_branch_a.md',
      dependsOn: ['gather'],
      contextFrom: ['gather'],
      output: { handoff: 'branch_a' },
    }),
    branch_b: step.prompt({
      promptFile: 'prompts/03_branch_b.md',
      dependsOn: ['gather'],
      contextFrom: ['gather'],
      output: { handoff: 'branch_b' },
    }),
    barrier: step.parallel({
      branches: ['branch_a', 'branch_b'],
      dependsOn: ['branch_a', 'branch_b'],
    }),
    merge: step.prompt({
      promptFile: 'prompts/04_merge.md',
      dependsOn: ['barrier'],
      contextFrom: ['gather', 'branch_a', 'branch_b'],
      output: { artifact: 'merged.md' },
    }),
  },
});
