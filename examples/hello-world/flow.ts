import { defineFlow, step, z } from '@relay/core';

const greet = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/01_greet.md',
  output: { handoff: 'greeting' },
} as Parameters<typeof step.prompt>[0]);

const summarize = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/02_summarize.md',
  dependsOn: ['greet'],
  contextFrom: ['greeting'],
  output: { artifact: 'greeting.md' },
} as Parameters<typeof step.prompt>[0]);

const flowResult = defineFlow({
  name: 'hello-world',
  version: '0.1.0',
  description: 'Two-step hello-world flow: greet the user, then write a short markdown greeting.',
  input: z.object({
    name: z.string().describe('The name of the person to greet.'),
  }),
  steps: {
    greet: greet._unsafeUnwrap(),
    summarize: summarize._unsafeUnwrap(),
  },
});

if (flowResult.isErr()) {
  throw new Error(`hello-world flow definition failed: ${flowResult.error.message}`);
}

export default flowResult.value;
