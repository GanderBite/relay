/**
 * Flow fixture for ask-inside-loop orchestrator tests.
 *
 * Topology: fix_loop (loop: implement -> feedback)
 *
 * fix_loop iterates until implement.done === true. Each iteration:
 * - `implement`: a prompt step that writes a handoff named 'implementation'
 *   with a `done` boolean field.
 * - `feedback`: an ask step that collects user feedback for the next iteration.
 *
 * The fixture is imported dynamically by Orchestrator.resume() when testing the
 * loop body ask pause/resume path.
 */
import { defineFlow, step, z } from '@ganderbite/relay-core';

export const flow = defineFlow({
  name: 'ask-loop-flow',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    fix_loop: step.loop({
      body: {
        implement: step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'implementation' },
        }),
        feedback: step.ask({
          questions: [{ id: 'comment', kind: 'text', label: 'Any feedback?' }],
          dependsOn: ['implement'],
        }),
      },
      until: { from: 'implementation', when: { done: true } },
      maxIterations: 3,
    }),
  },
});

export default flow;
