/**
 * Flow fixture for parallel-topology resume tests.
 *
 * Topology: entry -> parallel(c1, c2, c3) -> end
 *
 * The parallel runner fans out to three children. The resume test injects a
 * partial state where c1 and c2 have succeeded but c3 is still pending, then
 * asserts that only c3 and end execute on resume.
 *
 * This fixture is imported dynamically by resume() via importRace().
 */
import { defineRace, runner, z } from '@relay/core';

export const race = defineRace({
  name: 'parallel-resume-flow',
  version: '0.1.0',
  input: z.object({}),
  start: 'entry',
  runners: {
    entry: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'entry-out' },
    }),
    parallel: runner.parallel({
      branches: ['c1', 'c2', 'c3'],
      dependsOn: ['entry'],
    }),
    c1: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'c1-out' },
    }),
    c2: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'c2-out' },
    }),
    c3: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'c3-out' },
    }),
    end: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['parallel'],
      output: { baton: 'end-out' },
    }),
  },
});

export default race;
