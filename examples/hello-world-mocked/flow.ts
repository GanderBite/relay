import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'hello-world-mocked',
  version: '0.1.0',
  description: 'Two-step hello-world flow wired to run against a MockProvider.',
  input: z.object({
    name: z.string().describe('The name of the person to greet.'),
  }),
  steps: {
    greet: step.prompt({
      promptFile: 'prompts/01_greet.md',
      output: { handoff: 'greeting' },
    }),
    summarize: step.prompt({
      promptFile: 'prompts/02_summarize.md',
      dependsOn: ['greet'],
      contextFrom: ['greeting'],
      output: { artifact: 'greeting.md' },
    }),
  },
});
