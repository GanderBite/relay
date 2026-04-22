import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Three-runner linear race: {{stepNames[0]}} then {{stepNames[1]}} then {{stepNames[2]}}.',
  input: z.object({
    subject: z.string().describe('The subject the race operates on.'),
  }),
  runners: {
    '{{stepNames[0]}}': runner.prompt({
      promptFile: 'prompts/01_first.md',
      output: { baton: '{{stepNames[0]}}' },
    }),
    '{{stepNames[1]}}': runner.prompt({
      promptFile: 'prompts/02_second.md',
      dependsOn: ['{{stepNames[0]}}'],
      contextFrom: ['{{stepNames[0]}}'],
      output: { baton: '{{stepNames[1]}}' },
    }),
    '{{stepNames[2]}}': runner.prompt({
      promptFile: 'prompts/03_third.md',
      dependsOn: ['{{stepNames[1]}}'],
      contextFrom: ['{{stepNames[1]}}'],
      output: { baton: '{{stepNames[2]}}' },
    }),
  },
});
