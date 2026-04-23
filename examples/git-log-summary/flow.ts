import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'git-log-summary',
  version: '0.1.0',
  description:
    'Two-step script-then-prompt flow: capture the 20 most recent commits with git, then ask Claude to write a short changelog entry.',
  input: z.object({
    heading: z
      .string()
      .default('Recent Changes')
      .describe('The top-level heading used in the generated changelog entry.'),
  }),
  steps: {
    collectCommits: step.script({
      run: 'git log --oneline -20',
      output: { artifact: 'commits.txt' },
    }),
    summarize: step.prompt({
      promptFile: 'prompts/summarize-commits.md',
      dependsOn: ['collectCommits'],
      output: { artifact: 'changelog.md' },
    }),
  },
});
