/**
 * Fan-out / fan-in race.
 *
 * Topology:
 *
 *   prep ──▶ branch_a ─┐
 *        │             ├──▶ merge
 *        └─▶ branch_b ─┘
 *
 * The `prep` runner produces a baton both branches consume. The two branch
 * runners run concurrently; a `runner.parallel` acts as the fan-in barrier.
 * The `merge` runner waits on the barrier and reads both branch batons.
 */

import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Fan-out / fan-in race: prep → two parallel branches → merge.',
  input: z.object({
    topic: z.string().describe('The subject both branches analyze'),
  }),
  start: 'prep',
  runners: {
    prep: runner.prompt({
      promptFile: 'prompts/01_prep.md',
      output: { baton: 'prep' },
    }),
    branch_a: runner.prompt({
      promptFile: 'prompts/02_branch_a.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { baton: 'branch_a' },
    }),
    branch_b: runner.prompt({
      promptFile: 'prompts/03_branch_b.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { baton: 'branch_b' },
    }),
    barrier: runner.parallel({
      branches: ['branch_a', 'branch_b'],
      dependsOn: ['branch_a', 'branch_b'],
    }),
    merge: runner.prompt({
      promptFile: 'prompts/04_merge.md',
      dependsOn: ['barrier'],
      contextFrom: ['prep', 'branch_a', 'branch_b'],
      output: { artifact: 'merged.md' },
    }),
  },
});
