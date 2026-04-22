import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: 'hello-world-mocked',
  version: '0.1.0',
  description: 'Two-runner hello-world race wired to run against a MockProvider.',
  input: z.object({
    name: z.string().describe('The name of the person to greet.'),
  }),
  runners: {
    greet: runner.prompt({
      promptFile: 'prompts/01_greet.md',
      output: { baton: 'greeting' },
    }),
    summarize: runner.prompt({
      promptFile: 'prompts/02_summarize.md',
      dependsOn: ['greet'],
      contextFrom: ['greeting'],
      output: { artifact: 'greeting.md' },
    }),
  },
});
