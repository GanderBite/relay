/**
 * Flow fixture for partial parallel resume tests (TC-002).
 *
 * Topology: entry -> parallel(branchA, branchB) -> end
 *
 * The parallel step fans out to two children. The resume test injects a
 * partial state where the parallel step failed after branchA succeeded but
 * branchB failed, then asserts that only branchB (and end) execute on resume
 * while branchA is never re-invoked.
 *
 * This fixture is imported dynamically by resume() via importFlow().
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'partial-parallel-resume-flow',
  version: '0.1.0',
  input: z.object({}),
  start: 'entry',
  steps: {
    entry: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'entry-out' },
    }),
    parallel: step.parallel({
      branches: ['branchA', 'branchB'],
      dependsOn: ['entry'],
    }),
    branchA: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'branchA-out' },
    }),
    branchB: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'branchB-out' },
    }),
    end: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['parallel'],
      output: { handoff: 'end-out' },
    }),
  },
});

export default flow;
