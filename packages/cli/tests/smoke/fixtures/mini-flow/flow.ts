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

const greetStep = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/01.md',
  output: { handoff: 'greet-result' },
} as Parameters<typeof step.prompt>[0]);

const confirmStep = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/02.md',
  dependsOn: ['greet'],
  output: { artifact: 'result.txt' },
} as Parameters<typeof step.prompt>[0]);

const flowResult = defineFlow({
  name: 'smoke-mini',
  version: '0.1.0',
  description: 'Minimal two-step flow for smoke testing relay run end-to-end.',
  input: z.object({
    target: z.string().describe('What to greet'),
  }),
  steps: {
    greet: greetStep._unsafeUnwrap(),
    confirm: confirmStep._unsafeUnwrap(),
  },
});

if (flowResult.isErr()) {
  throw new Error(`smoke-mini flow definition failed: ${flowResult.error.message}`);
}

export default flowResult.value;
