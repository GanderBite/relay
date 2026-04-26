/**
 * Fixture flow for the state-version-mismatch integration test (TC-005).
 *
 * Name and version are deliberately mismatched against the seeded state.json
 * (which records version '0.1.0'). Resume must reject with
 * StateVersionMismatchError before invoking any provider.
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'my-flow',
  version: '0.2.0',
  input: z.object({}),
  steps: {
    'step-a': step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'step-a-out' },
    }),
  },
});

export default flow;
