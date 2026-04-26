/**
 * Flow fixture for branch-topology resume tests.
 *
 * Topology: entry -> b1 -> b2 -> end
 *                    ^
 *            (a1 and a2 are defined as "branch A" but are marked
 *             skipped in the injected state to simulate that the
 *             branch predicate selected path B)
 *
 * This fixture is imported dynamically by resume() via importFlow().
 * It must compile under --experimental-strip-types and must be importable
 * both from vitest (for the test step) and via pathToFileURL().
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'branch-resume-flow',
  version: '0.1.0',
  input: z.object({}),
  start: 'entry',
  steps: {
    entry: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'entry-out' },
    }),
    b1: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['entry'],
      output: { handoff: 'b1-out' },
    }),
    b2: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['b1'],
      output: { handoff: 'b2-out' },
    }),
    a1: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['entry'],
      output: { handoff: 'a1-out' },
    }),
    a2: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['a1'],
      output: { handoff: 'a2-out' },
    }),
    end: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['b2'],
      output: { handoff: 'end-out' },
    }),
  },
});

export default flow;
