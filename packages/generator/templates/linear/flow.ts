import { defineFlow, step, z } from '@ganderbite/relay-core';

// To declare env sources explicitly on a script step:
// step.script({
//   env: {
//     REPO: { from: 'input.repo', required: true },
//     TITLE: { from: 'handoff.plan.title' },
//   },
//   run: ['bash', 'scripts/build.sh'],
// })
//
// Auto-injected per script step: RELAY_RUN_DIR, RELAY_FLOW_DIR,
// RELAY_HANDOFFS_DIR, RELAY_INPUT_JSON.

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Three-step linear flow: gather a goal from the operator, then {{stepNames[0]}}, then {{stepNames[1]}}.',
  input: z.object({
    subject: z.string().describe('The subject the flow operates on.'),
  }),
  steps: {
    gather: step.ask({
      questions: [{ id: 'goal', kind: 'text', label: 'What is the goal for this run?' }],
    }),
    '{{stepNames[0]}}': step.prompt({
      promptFile: 'prompts/01_first.md',
      dependsOn: ['gather'],
      contextFrom: ['gather'],
      output: { handoff: '{{stepNames[0]}}' },
    }),
    '{{stepNames[1]}}': step.prompt({
      promptFile: 'prompts/02_second.md',
      dependsOn: ['{{stepNames[0]}}'],
      contextFrom: ['{{stepNames[0]}}'],
      output: { handoff: '{{stepNames[1]}}' },
    }),
  },
});
