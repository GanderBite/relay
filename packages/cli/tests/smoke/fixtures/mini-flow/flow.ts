/**
 * Minimal two-step smoke flow.
 *
 * Build before running the smoke test:
 *   pnpm -C packages/cli/tests/smoke/fixtures/mini-flow build
 *
 * Or compile manually:
 *   npx tsc --outDir dist --module NodeNext --moduleResolution NodeNext \
 *     --target ES2022 --strict --skipLibCheck flow.ts
 */

import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'smoke-mini',
  version: '0.1.0',
  description: 'Minimal two-step flow for smoke testing relay run end-to-end.',
  input: z.object({
    target: z.string().describe('What to greet'),
  }),
  steps: {
    greet: step.prompt({
      promptFile: 'prompts/01.md',
      output: { handoff: 'greet-result' },
    }),
    confirm: step.prompt({
      promptFile: 'prompts/02.md',
      dependsOn: ['greet'],
      output: { artifact: 'result.txt' },
    }),
  },
});
