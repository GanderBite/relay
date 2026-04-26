import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: 'git-log-summary',
  version: '0.1.0',
  description:
    'Two-step script-then-prompt flow: a script step gates on git being available in a repo, then a prompt step asks Claude to read the log and write a short changelog entry.',
  input: z.object({
    heading: z
      .string()
      .default('Recent Changes')
      .describe('The top-level heading used in the generated changelog entry.'),
  }),
  steps: {
    checkGit: step.script({
      run: 'git log --oneline -20',
      output: { artifact: 'commits.txt' },
    }),
    summarize: step.prompt({
      promptFile: 'prompts/summarize-commits.md',
      dependsOn: ['checkGit'],
      output: { artifact: 'changelog.md' },
    }),
  },
});
