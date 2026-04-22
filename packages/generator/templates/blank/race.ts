import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'A Relay race.',
  input: z.object({
    subject: z.string(),
  }),
  runners: {
    first: runner.prompt({
      promptFile: 'prompts/01_first.md',
      output: { baton: 'result' },
    }),
  },
});
