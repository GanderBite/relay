/**
 * Flow fixture for the retry-budget-cumulative resume test.
 *
 * A single prompt step with maxRetries:1 — total attempt budget is 2
 * (1 original + 1 retry). Used to verify that a resume against a state.json
 * whose step already records attempts:2 does not grant additional attempts
 * beyond what the budget allows.
 */
import { defineFlow, step, z } from '@relay/core';

export const flow = defineFlow({
  name: 'retry-budget-flow',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    'step-a': step.prompt({
      promptFile: 'p.md',
      maxRetries: 1,
      output: { handoff: 'step-a-out' },
    }),
  },
});

export default flow;
