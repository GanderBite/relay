import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'A Relay flow.',
  input: z.object({
    subject: z.string(),
  }),
  steps: {
    first: step.prompt({
      promptFile: 'prompts/01_first.md',
      output: { handoff: 'result' },
    }),
  },
});
