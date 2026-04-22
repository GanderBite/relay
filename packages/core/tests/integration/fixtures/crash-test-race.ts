/**
 * Minimal two-step flow used by the crash-resume integration test.
 *
 * Exported as both default and named `flow` so importRace() finds it
 * regardless of which export shape it checks first.
 *
 * This file is imported by:
 *   - The child harness (via --experimental-strip-types) at run start
 *   - The parent test (via Vitest's module runner) inside Runner.resume()
 *
 * Both import paths resolve @relay/core to the compiled dist because this
 * file lives under packages/core, which is the @relay/core package root.
 */
import { defineRace, runner, z } from '@relay/core';

export const race = defineRace({
  name: 'crash-test-flow',
  version: '0.1.0',
  input: z.object({}),
  runners: {
    a: runner.prompt({
      promptFile: 'p.md',
      output: { baton: 'a-out' },
    }),
    b: runner.prompt({
      promptFile: 'p.md',
      dependsOn: ['a'],
      output: { baton: 'b-out' },
    }),
  },
});

export default race;
