import { defineFlow, step, z } from '@relay/core';

export const flow = defineFlow({
  name: 'linear',
  version: '0.1.0',
  defaultProvider: 'mock',
  input: z.object({}),
  steps: {
    a: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'a-out' },
    }),
    b: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['a'],
      output: { handoff: 'b-out' },
    }),
    c: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['b'],
      output: { handoff: 'c-out' },
    }),
  },
});

export default flow;
