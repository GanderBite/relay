import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Three-step linear flow: {{stepNames[0]}} then {{stepNames[1]}} then {{stepNames[2]}}.',
  input: z.object({
    subject: z.string().describe('The subject the flow operates on.'),
  }),
  steps: {
    '{{stepNames[0]}}': step.prompt({
      promptFile: 'prompts/01_first.md',
      output: { handoff: '{{stepNames[0]}}' },
    }),
    '{{stepNames[1]}}': step.prompt({
      promptFile: 'prompts/02_second.md',
      dependsOn: ['{{stepNames[0]}}'],
      contextFrom: ['{{stepNames[0]}}'],
      output: { handoff: '{{stepNames[1]}}' },
    }),
    '{{stepNames[2]}}': step.prompt({
      promptFile: 'prompts/03_third.md',
      dependsOn: ['{{stepNames[1]}}'],
      contextFrom: ['{{stepNames[1]}}'],
      output: { handoff: '{{stepNames[2]}}' },
    }),
  },
});
