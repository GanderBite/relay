/**
 * Race fixture for branch-topology resume tests.
 *
 * Topology: entry -> b1 -> b2 -> end
 *                    ^
 *            (a1 and a2 are defined as "branch A" but are marked
 *             skipped in the injected state to simulate that the
 *             branch predicate selected path B)
 *
 * This fixture is imported dynamically by resume() via importRace().
 * It must compile under --experimental-strip-types and must be importable
 * both from vitest (for the test runner) and via pathToFileURL().
 */
import { defineRace, runner, z } from '@relay/core';

export const race = defineRace({
  name: 'branch-resume-flow',
  version: '0.1.0',
  input: z.object({}),
  start: 'entry',
  runners: {
    entry: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'entry-out' },
    }),
    b1: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['entry'],
      output: { baton: 'b1-out' },
    }),
    b2: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['b1'],
      output: { baton: 'b2-out' },
    }),
    a1: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['entry'],
      output: { baton: 'a1-out' },
    }),
    a2: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['a1'],
      output: { baton: 'a2-out' },
    }),
    end: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['b2'],
      output: { baton: 'end-out' },
    }),
  },
});

export default race;
