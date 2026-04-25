import { describe, expect, it } from 'vitest';
import { ERROR_CODES, FlowDefinitionError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { terminalStep } from '../../src/flow/steps/terminal.js';
import { z } from '../../src/zod.js';

// A single terminal step is the minimal valid step set for defineFlow.
// It produces a single root with no outgoing edges, satisfying the DAG builder.
const MINIMAL_STEPS = {
  done: terminalStep({}),
};

function makeValidSpec(name: string) {
  return {
    name,
    version: '1.0.0',
    description: 'test flow',
    input: z.object({ text: z.string() }),
    steps: MINIMAL_STEPS,
  };
}

describe('defineFlow — name validation', () => {
  const invalidNames = [
    ['MyFlow', 'uppercase letters'],
    ['my flow', 'space'],
    ['-myflow', 'leading hyphen'],
    ['my--flow', 'double hyphen'],
  ] as const;

  for (const [name, reason] of invalidNames) {
    it(`[TC-022] name "${name}" (${reason}) throws FlowDefinitionError`, () => {
      expect(() => defineFlow(makeValidSpec(name))).toThrow(FlowDefinitionError);
    });

    it(`[TC-022] name "${name}" (${reason}) carries code ${ERROR_CODES.FLOW_DEFINITION}`, () => {
      try {
        defineFlow(makeValidSpec(name));
        // force a failure if defineFlow did not throw
        expect.fail('expected defineFlow to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(FlowDefinitionError);
        if (e instanceof FlowDefinitionError) {
          expect(e.code).toBe(ERROR_CODES.FLOW_DEFINITION);
        }
      }
    });
  }

  it('[TC-022] name "my-flow-2" (valid kebab-case with digit) does NOT throw', () => {
    const flow = defineFlow(makeValidSpec('my-flow-2'));
    expect(flow.name).toBe('my-flow-2');
  });

  it('[TC-022] valid name "my-flow-2" returns a frozen Flow object with correct fields', () => {
    const flow = defineFlow(makeValidSpec('my-flow-2'));
    expect(flow.version).toBe('1.0.0');
    expect(flow.steps).toHaveProperty('done');
    expect(Object.isFrozen(flow)).toBe(true);
  });
});
