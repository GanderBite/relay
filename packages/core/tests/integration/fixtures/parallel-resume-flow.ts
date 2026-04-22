/**
 * Flow fixture for parallel-topology resume tests.
 *
 * Topology: entry -> parallel(c1, c2, c3) -> end
 *
 * The parallel step fans out to three children. The resume test injects a
 * partial state where c1 and c2 have succeeded but c3 is still pending, then
 * asserts that only c3 and end execute on resume.
 *
 * This fixture is imported dynamically by resume() via importFlow().
 */
import { defineFlow, step, z } from '@relay/core';

export const flow = defineFlow({
  name: 'parallel-resume-flow',
  version: '0.1.0',
  input: z.object({}),
  start: 'entry',
  steps: {
    entry: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'entry-out' },
    }),
    parallel: step.parallel({
      branches: ['c1', 'c2', 'c3'],
      dependsOn: ['entry'],
    }),
    c1: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'c1-out' },
    }),
    c2: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'c2-out' },
    }),
    c3: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'c3-out' },
    }),
    end: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['parallel'],
      output: { handoff: 'end-out' },
    }),
  },
});

export default flow;
