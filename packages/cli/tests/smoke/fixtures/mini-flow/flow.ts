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

import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: 'smoke-mini',
  version: '0.1.0',
  description: 'Minimal two-runner race for smoke testing relay run end-to-end.',
  input: z.object({
    target: z.string().describe('What to greet'),
  }),
  runners: {
    greet: runner.prompt({
      promptFile: 'prompts/01.md',
      output: { baton: 'greet-result' },
    }),
    confirm: runner.prompt({
      promptFile: 'prompts/02.md',
      dependsOn: ['greet'],
      output: { artifact: 'result.txt' },
    }),
  },
});
