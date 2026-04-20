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

const prepStep = step.prompt({
  promptFile: 'prompts/01_prep.md',
  output: { handoff: 'prep' },
});

const branchAStep = step.prompt({
  promptFile: 'prompts/02_branch_a.md',
  dependsOn: ['prep'],
  contextFrom: ['prep'],
  output: { handoff: 'branch_a' },
});

const branchBStep = step.prompt({
  promptFile: 'prompts/03_branch_b.md',
  dependsOn: ['prep'],
  contextFrom: ['prep'],
  output: { handoff: 'branch_b' },
});

const barrierStep = step.parallel({
  branches: ['branch_a', 'branch_b'],
  dependsOn: ['branch_a', 'branch_b'],
});

const mergeStep = step.prompt({
  promptFile: 'prompts/04_merge.md',
  dependsOn: ['barrier'],
  contextFrom: ['prep', 'branch_a', 'branch_b'],
  output: { artifact: 'merged.md' },
});

const flowResult = defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Fan-out / fan-in flow: prep → two parallel branches → merge.',
  input: z.object({
    topic: z.string().describe('The subject both branches analyze'),
  }),
  start: 'prep',
  steps: {
    prep: prepStep._unsafeUnwrap(),
    branch_a: branchAStep._unsafeUnwrap(),
    branch_b: branchBStep._unsafeUnwrap(),
    barrier: barrierStep._unsafeUnwrap(),
    merge: mergeStep._unsafeUnwrap(),
  },
});

if (flowResult.isErr()) {
  throw new Error(`fan-out flow definition failed: ${flowResult.error.message}`);
}

export default flowResult.value;
