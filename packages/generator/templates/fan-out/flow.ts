/**
 * Fan-out / fan-in flow.
 *
 * Topology:
 *
 *   prep ──▶ branch_a ─┐
 *        │             ├──▶ merge
 *        └─▶ branch_b ─┘
 *
 * The `prep` step produces a handoff both branches consume. The two branch
 * steps run concurrently; a `step.parallel` acts as the fan-in barrier. The
 * `merge` step waits on the barrier and reads both branch handoffs.
 */

import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Fan-out / fan-in flow: prep → two parallel branches → merge.',
  input: z.object({
    topic: z.string().describe('The subject both branches analyze'),
  }),
  start: 'prep',
  steps: {
    prep: step.prompt({
      promptFile: 'prompts/01_prep.md',
      output: { handoff: 'prep' },
    }),
    branch_a: step.prompt({
      promptFile: 'prompts/02_branch_a.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { handoff: 'branch_a' },
    }),
    branch_b: step.prompt({
      promptFile: 'prompts/03_branch_b.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { handoff: 'branch_b' },
    }),
    barrier: step.parallel({
      branches: ['branch_a', 'branch_b'],
      dependsOn: ['branch_a', 'branch_b'],
    }),
    merge: step.prompt({
      promptFile: 'prompts/04_merge.md',
      dependsOn: ['barrier'],
      contextFrom: ['prep', 'branch_a', 'branch_b'],
      output: { artifact: 'merged.md' },
    }),
  },
});
