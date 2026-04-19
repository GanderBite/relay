/**
 * Flow fixture for parallel-topology resume tests.
 *
 * Topology: entry -> parallel(c1, c2, c3) -> end
 *
 * The parallel step fans out to three children. The resume test injects a
 * partial state where c1 and c2 have succeeded but c3 is still pending, then
 * asserts that only c3 and end execute on resume.
 *
 * This fixture is imported dynamically by resume() via importFlow().
 */
import { defineFlow, step, z } from '@relay/core';

const entryStep = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'entry-out' },
} as Parameters<typeof step.prompt>[0]);

const c1Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'c1-out' },
} as Parameters<typeof step.prompt>[0]);

const c2Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'c2-out' },
} as Parameters<typeof step.prompt>[0]);

const c3Step = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  output: { handoff: 'c3-out' },
} as Parameters<typeof step.prompt>[0]);

const parallelStep = step.parallel({
  id: '',
  kind: 'parallel',
  branches: ['c1', 'c2', 'c3'],
  dependsOn: ['entry'],
} as Parameters<typeof step.parallel>[0]);

const endStep = step.prompt({
  id: '',
  kind: 'prompt',
  promptFile: 'p.md',
  dependsOn: ['parallel'],
  output: { handoff: 'end-out' },
} as Parameters<typeof step.prompt>[0]);

export const flow = defineFlow({
  name: 'parallel-resume-flow',
  version: '0.1.0',
  defaultProvider: 'mock',
  input: z.object({}),
  start: 'entry',
  steps: {
    entry: entryStep._unsafeUnwrap(),
    parallel: parallelStep._unsafeUnwrap(),
    c1: c1Step._unsafeUnwrap(),
    c2: c2Step._unsafeUnwrap(),
    c3: c3Step._unsafeUnwrap(),
    end: endStep._unsafeUnwrap(),
  },
})._unsafeUnwrap();

export default flow;
