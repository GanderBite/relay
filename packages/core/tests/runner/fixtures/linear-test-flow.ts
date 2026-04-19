import { defineFlow, step, z } from '@relay/core';

const specA = step.prompt({
  id: 'a',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'a-out' },
} as Parameters<typeof step.prompt>[0]);

const specB = step.prompt({
  id: 'b',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['a'],
  output: { handoff: 'b-out' },
} as Parameters<typeof step.prompt>[0]);

const specC = step.prompt({
  id: 'c',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['b'],
  output: { handoff: 'c-out' },
} as Parameters<typeof step.prompt>[0]);

export const flow = defineFlow({
  name: 'linear',
  version: '0.1.0',
  defaultProvider: 'mock',
  input: z.object({}),
  steps: {
    a: specA._unsafeUnwrap(),
    b: specB._unsafeUnwrap(),
    c: specC._unsafeUnwrap(),
  },
})._unsafeUnwrap();

export default flow;
