/**
 * Minimal two-step flow used by the crash-resume integration test.
 *
 * Exported as both default and named `flow` so importFlow() finds it
 * regardless of which export shape it checks first.
 *
 * This file is imported by:
 *   - The child harness (via --experimental-strip-types) at run start
 *   - The parent test (via Vitest's module runner) inside Runner.resume()
 *
 * Both import paths resolve @relay/core to the compiled dist because this
 * file lives under packages/core, which is the @relay/core package root.
 */
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

export const flow = defineFlow({
  name: 'crash-test-flow',
  version: '0.1.0',
  defaultProvider: 'mock',
  input: z.object({}),
  steps: {
    a: specA._unsafeUnwrap(),
    b: specB._unsafeUnwrap(),
  },
})._unsafeUnwrap();

export default flow;
