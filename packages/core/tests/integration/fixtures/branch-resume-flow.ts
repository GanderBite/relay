/**
 * Flow fixture for branch-topology resume tests.
 *
 * Topology: entry -> b1 -> b2 -> end
 *                    ^
 *            (a1 and a2 are defined as "branch A" but are marked
 *             skipped in the injected state to simulate that the
 *             branch predicate selected path B)
 *
 * This fixture is imported dynamically by resume() via importFlow().
 * It must compile under --experimental-strip-types and must be importable
 * both from vitest (for the test runner) and via pathToFileURL().
 */
import { defineFlow, step, z } from '@relay/core';

const entryStep = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'entry-out' },
} as Parameters<typeof step.prompt>[0]);

const b1Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['entry'],
  output: { handoff: 'b1-out' },
} as Parameters<typeof step.prompt>[0]);

const b2Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['b1'],
  output: { handoff: 'b2-out' },
} as Parameters<typeof step.prompt>[0]);

const a1Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['entry'],
  output: { handoff: 'a1-out' },
} as Parameters<typeof step.prompt>[0]);

const a2Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['a1'],
  output: { handoff: 'a2-out' },
} as Parameters<typeof step.prompt>[0]);

const endStep = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['b2'],
  output: { handoff: 'end-out' },
} as Parameters<typeof step.prompt>[0]);

export const flow = defineFlow({
  name: 'branch-resume-flow',
  version: '0.1.0',
  defaultProvider: 'mock',
  input: z.object({}),
  start: 'entry',
  steps: {
    entry: entryStep._unsafeUnwrap(),
    b1: b1Step._unsafeUnwrap(),
    b2: b2Step._unsafeUnwrap(),
    a1: a1Step._unsafeUnwrap(),
    a2: a2Step._unsafeUnwrap(),
    end: endStep._unsafeUnwrap(),
  },
})._unsafeUnwrap();

export default flow;
