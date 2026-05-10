import { defineFlow, step, z } from '@ganderbite/relay-core';

/**
 * Interactive flow: pause for human input, then run a prompt that consumes
 * the answers. The `gather` step pauses the run and waits for `relay answer`
 * to provide values for each question. The `execute` step then reads those
 * answers from the ask-step's answer handoff (key: `__ask_<stepId>__`) and
 * produces a result.
 *
 * Question kinds available on `step.ask`: text, multiline, select,
 * multiselect, confirm, number. Add or swap kinds to fit your task.
 */
export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Interactive flow: pause for human input, then run a prompt that consumes the answers.',
  input: z.object({
    topic: z.string().describe('A short topic the run is about.'),
  }),
  steps: {
    gather: step.ask({
      questions: [
        { id: 'goal', kind: 'text', label: 'What is the goal of this run?' },
        { id: 'confirm', kind: 'confirm', label: 'Proceed with the above goal?' },
      ],
    }),
    execute: step.prompt({
      promptFile: 'prompts/01_execute.md',
      dependsOn: ['gather'],
      contextFrom: ['__ask_gather__'],
      output: { handoff: 'result' },
    }),
  },
});
