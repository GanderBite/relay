/**
 * Minimal two-step flow used by the crash-resume integration test.
 *
 * Exported as both default and named `flow` so importFlow() finds it
 * regardless of which export shape it checks first.
 *
 * This file is imported by:
 *   - The child harness (via --experimental-strip-types) at run start
 *   - The parent test (via Vitest's module step) inside Orchestrator.resume()()
 *
 * Both import paths resolve @ganderbite/relay-core to the compiled dist because this
 * file lives under packages/core, which is the @ganderbite/relay-core package root.
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'crash-test-flow',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    a: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'a-out' },
    }),
    b: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['a'],
      output: { handoff: 'b-out' },
    }),
  },
});

export default flow;
