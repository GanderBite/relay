import { defineFlow, step, z } from '@relay/core';

const step1 = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/01_first.md',
  output: { handoff: '{{stepNames[0]}}' },
} as Parameters<typeof step.prompt>[0]);

const step2 = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/02_second.md',
  dependsOn: ['{{stepNames[0]}}'],
  contextFrom: ['{{stepNames[0]}}'],
  output: { handoff: '{{stepNames[1]}}' },
} as Parameters<typeof step.prompt>[0]);

const step3 = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/03_third.md',
  dependsOn: ['{{stepNames[1]}}'],
  contextFrom: ['{{stepNames[1]}}'],
  output: { handoff: '{{stepNames[2]}}' },
} as Parameters<typeof step.prompt>[0]);

const flowResult = defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Three-step linear flow: {{stepNames[0]}} then {{stepNames[1]}} then {{stepNames[2]}}.',
  input: z.object({
    subject: z.string().describe('The subject the flow operates on.'),
  }),
  steps: {
    '{{stepNames[0]}}': step1._unsafeUnwrap(),
    '{{stepNames[1]}}': step2._unsafeUnwrap(),
    '{{stepNames[2]}}': step3._unsafeUnwrap(),
  },
});

if (flowResult.isErr()) {
  throw new Error(`{{pkgName}} flow definition failed: ${flowResult.error.message}`);
}

export default flowResult.value;
