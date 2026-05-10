/**
 * Flow fixture for parallel-branch ask pause/resume tests.
 *
 * Topology: barrier(askBranch, promptBranch) -> conclude
 *
 * The barrier fans out to two branches:
 * - askBranch: an ask step that pauses the run for user input.
 * - promptBranch: a prompt step that either completes before the pause (TC-1)
 *   or is still in-flight when the ask fires (TC-2, depending on provider latency).
 *
 * conclude runs after the barrier succeeds on resume.
 *
 * This fixture is imported dynamically by Orchestrator.resume() via importFlow().
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'ask-parallel-flow',
  version: '0.0.1',
  input: z.object({}),
  steps: {
    barrier: step.parallel({
      branches: ['askBranch', 'promptBranch'],
    }),
    askBranch: step.ask({
      questions: [{ id: 'answer', kind: 'text', label: 'Your answer?' }],
    }),
    promptBranch: step.prompt({
      promptFile: 'p.md',
      output: { handoff: 'prompt-out' },
    }),
    conclude: step.prompt({
      promptFile: 'p.md',
      dependsOn: ['barrier'],
      output: { handoff: 'conclude-out' },
    }),
  },
});

export default flow;
