/**
 * Flow fixture for sequential top-level ask step pause/resume tests.
 *
 * Topology: step-ask-1 -> step-ask-2 (sequential, no other steps)
 *
 * Two ask steps in sequence. The first ask step pauses the run for user input.
 * After the answer file is written and the run resumes, the second ask step
 * pauses again. After the second answer file is written and the run resumes
 * again, the flow succeeds.
 *
 * This fixture is imported dynamically by Orchestrator.resume() via importFlow().
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'ask-sequential-flow',
  version: '0.0.1',
  input: z.object({}),
  steps: {
    'step-ask-1': step.ask({
      questions: [{ id: 'first', kind: 'text', label: 'First question?' }],
    }),
    'step-ask-2': step.ask({
      questions: [{ id: 'second', kind: 'text', label: 'Second question?' }],
      dependsOn: ['step-ask-1'],
    }),
  },
});

export default flow;
