import { defineRace, runner, z } from '@relay/core';

export const race = defineRace({
  name: 'linear',
  version: '0.1.0',
  input: z.object({}),
  runners: {
    a: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'a-out' },
    }),
    b: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['a'],
      output: { baton: 'b-out' },
    }),
    c: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['b'],
      output: { baton: 'c-out' },
    }),
  },
});

export default race;
