import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'ask-then-prompt',
  version: '0.0.1',
  input: z.object({}),
  steps: {
    gather: step.ask({
      questions: [{ id: 'name', kind: 'text', label: 'Your name?' }],
    }),
    execute: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['gather'],
      contextFrom: ['gather'],
      output: { handoff: 'result' },
    }),
  },
});

export default flow;
