import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { buildGraph } from '../../src/flow/graph.js';
import {
  DynamicQuestionSourceSchema,
  QuestionSchema,
  QuestionsArraySchema,
} from '../../src/flow/question.js';
import { step } from '../../src/flow/step.js';
import { askStep } from '../../src/flow/steps/ask.js';
import type { AskStep, PromptStep, Step } from '../../src/flow/types.js';
import { z } from '../../src/zod.js';

// ---------------------------------------------------------------------------
// QuestionSchema — discriminated union parse tests
// ---------------------------------------------------------------------------

describe('QuestionSchema — text question', () => {
  it('parses a minimal text question', () => {
    const result = QuestionSchema.safeParse({ id: 'q1', kind: 'text', label: 'Name?' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('text');
      expect(result.data.id).toBe('q1');
    }
  });

  it('parses a text question with optional fields', () => {
    const result = QuestionSchema.safeParse({
      id: 'q1',
      kind: 'text',
      label: 'Name?',
      placeholder: 'Enter your name',
      required: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'text') {
      expect(result.data.placeholder).toBe('Enter your name');
      expect(result.data.required).toBe(true);
    }
  });
});

describe('QuestionSchema — confirm question', () => {
  it('parses a confirm question', () => {
    const result = QuestionSchema.safeParse({ id: 'c1', kind: 'confirm', label: 'Continue?' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('confirm');
    }
  });

  it('parses a confirm question with a default value', () => {
    const result = QuestionSchema.safeParse({
      id: 'c1',
      kind: 'confirm',
      label: 'Continue?',
      default: false,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'confirm') {
      expect(result.data.default).toBe(false);
    }
  });
});

describe('QuestionSchema — select question', () => {
  it('parses a select question with options', () => {
    const result = QuestionSchema.safeParse({
      id: 's1',
      kind: 'select',
      label: 'Choose:',
      options: ['a', 'b', 'c'],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'select') {
      expect(result.data.options).toEqual(['a', 'b', 'c']);
    }
  });

  it('fails when select question is missing options', () => {
    const result = QuestionSchema.safeParse({ id: 's1', kind: 'select', label: 'Choose:' });
    expect(result.success).toBe(false);
  });
});

describe('QuestionSchema — multiselect question', () => {
  it('parses a multiselect question', () => {
    const result = QuestionSchema.safeParse({
      id: 'ms1',
      kind: 'multiselect',
      label: 'Pick all:',
      options: ['x', 'y'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('multiselect');
    }
  });
});

describe('QuestionSchema — invalid inputs', () => {
  it('fails when kind is not a known discriminant', () => {
    const result = QuestionSchema.safeParse({ id: 'q', kind: 'dropdown', label: 'Choose?' });
    expect(result.success).toBe(false);
  });

  it('fails when required id field is missing', () => {
    const result = QuestionSchema.safeParse({ kind: 'text', label: 'Name?' });
    expect(result.success).toBe(false);
  });

  it('fails when required label field is missing', () => {
    const result = QuestionSchema.safeParse({ id: 'q1', kind: 'text' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QuestionsArraySchema
// ---------------------------------------------------------------------------

describe('QuestionsArraySchema', () => {
  it('parses a mixed array of valid questions', () => {
    const result = QuestionsArraySchema.safeParse([
      { id: 'q1', kind: 'text', label: 'Name?' },
      { id: 'q2', kind: 'confirm', label: 'OK?' },
      { id: 'q3', kind: 'select', label: 'Pick:', options: ['a', 'b'] },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(3);
    }
  });

  it('fails when any element has an invalid kind', () => {
    const result = QuestionsArraySchema.safeParse([
      { id: 'q1', kind: 'text', label: 'Name?' },
      { id: 'q2', kind: 'bad', label: 'Oops' },
    ]);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DynamicQuestionSourceSchema
// ---------------------------------------------------------------------------

describe('DynamicQuestionSourceSchema', () => {
  it('parses { from: "someHandoff" }', () => {
    const result = DynamicQuestionSourceSchema.safeParse({ from: 'someHandoff' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe('someHandoff');
    }
  });

  it('fails when from is not a string', () => {
    const result = DynamicQuestionSourceSchema.safeParse({ from: 42 });
    expect(result.success).toBe(false);
  });

  it('fails when from key is absent', () => {
    const result = DynamicQuestionSourceSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// step.ask builder — id comes from defineFlow record key, not from builder input
// ---------------------------------------------------------------------------

describe('step.ask builder — valid inputs', () => {
  it('returns an AskStepBuilderOutput with kind === "ask" for static questions', () => {
    const output = askStep({
      questions: [{ id: 'q1', kind: 'text', label: 'Name?' }],
    });
    expect(output.kind).toBe('ask');
    expect(Array.isArray(output.questions)).toBe(true);
  });

  it('returns an AskStepBuilderOutput with kind === "ask" for a dynamic source', () => {
    const output = askStep({ questions: { from: 'priorHandoff' } });
    expect(output.kind).toBe('ask');
    expect(output.questions).toEqual({ from: 'priorHandoff' });
  });

  it('round-trips through defineFlow and gives the step an id from the record key', () => {
    const flow = defineFlow({
      name: 'ask-flow',
      version: '1.0.0',
      input: z.object({}),
      steps: {
        gather: askStep({ questions: [{ id: 'q1', kind: 'text', label: 'Name?' }] }),
      },
    });
    const gatherStep = flow.steps['gather'];
    expect(gatherStep).toBeDefined();
    expect(gatherStep?.kind).toBe('ask');
    expect(gatherStep?.id).toBe('gather');
  });

  it('accepts optional name field', () => {
    const output = askStep({
      name: 'user-details',
      questions: [{ id: 'q1', kind: 'confirm', label: 'Ready?' }],
    });
    expect(output.kind).toBe('ask');
    expect((output as { name?: string }).name).toBe('user-details');
  });

  it('accepts an output.schema field', () => {
    const schema = z.object({ q1: z.string() });
    const output = askStep({
      questions: [{ id: 'q1', kind: 'text', label: 'Value?' }],
      output: { schema },
    });
    expect(output.kind).toBe('ask');
    expect((output as { output?: { schema: unknown } }).output?.schema).toBe(schema);
  });
});

describe('step.ask builder — valid edge cases', () => {
  it('accepts an empty questions array (schema allows it)', () => {
    const output = askStep({ questions: [] });
    expect(output.kind).toBe('ask');
    expect(Array.isArray(output.questions)).toBe(true);
    expect((output.questions as unknown[]).length).toBe(0);
  });
});

describe('step.ask builder — invalid inputs', () => {
  it('throws FlowDefinitionError when a question has an invalid kind', () => {
    expect(() =>
      askStep({ questions: [{ id: 'q', kind: 'unknown' as 'text', label: 'Oops' }] }),
    ).toThrow(FlowDefinitionError);
  });

  it('throws FlowDefinitionError when questions field is missing', () => {
    expect(() => askStep({} as Parameters<typeof askStep>[0])).toThrow(FlowDefinitionError);
  });
});

// ---------------------------------------------------------------------------
// graph.ts — validateAskQuestionSources
// ---------------------------------------------------------------------------

function promptStep(id: string, extra?: Partial<PromptStep>): PromptStep {
  return {
    id,
    kind: 'prompt',
    promptFile: 'p.md',
    output: { handoff: `${id}-out` },
    ...extra,
  } as PromptStep;
}

function askStepFixed(id: string, extra?: Partial<AskStep>): AskStep {
  return {
    id,
    kind: 'ask',
    questions: [{ id: 'q1', kind: 'text', label: 'Q?' }],
    ...extra,
  } as AskStep;
}

describe('graph validation — ask steps with static questions', () => {
  it('accepts an ask step with a static questions array', () => {
    const steps: Record<string, Step> = {
      gather: askStepFixed('gather'),
    };
    const result = buildGraph(steps);
    expect(result.isOk()).toBe(true);
  });

  it('ask step appears in topological order', () => {
    const steps: Record<string, Step> = {
      gather: askStepFixed('gather'),
    };
    const result = buildGraph(steps);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.topoOrder).toContain('gather');
  });
});

describe('graph validation — ask step with dynamic question source', () => {
  it('accepts dynamic source referencing a preceding prompt handoff', () => {
    const steps: Record<string, Step> = {
      producer: promptStep('producer', { output: { handoff: 'q-list' } }),
      gather: askStepFixed('gather', {
        questions: { from: 'q-list' },
        dependsOn: ['producer'],
      }),
    };
    const result = buildGraph(steps);
    expect(result.isOk()).toBe(true);
  });

  it('rejects dynamic source referencing a non-preceding handoff (sibling)', () => {
    const steps: Record<string, Step> = {
      root: { id: 'root', kind: 'terminal' } satisfies Step,
      sibling: promptStep('sibling', { dependsOn: ['root'], output: { handoff: 'q-list' } }),
      gather: askStepFixed('gather', {
        questions: { from: 'q-list' },
        dependsOn: ['root'],
      }),
    };
    const result = buildGraph(steps, 'root');
    expect(result.isErr()).toBe(true);
    const msg = result._unsafeUnwrapErr().message;
    expect(msg).toContain('gather');
    expect(msg).toContain('q-list');
  });

  it('rejects dynamic source referencing an unknown handoff', () => {
    const steps: Record<string, Step> = {
      gather: askStepFixed('gather', {
        questions: { from: 'ghost-handoff' },
      }),
    };
    const result = buildGraph(steps);
    expect(result.isErr()).toBe(true);
    const err = result._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect(err.message).toContain('ghost-handoff');
    expect(err.message).toContain('gather');
  });

  it('error message for non-preceding handoff names the upstream step', () => {
    const steps: Record<string, Step> = {
      root: { id: 'root', kind: 'terminal' } satisfies Step,
      writer: promptStep('writer', { dependsOn: ['root'], output: { handoff: 'my-data' } }),
      asker: askStepFixed('asker', {
        questions: { from: 'my-data' },
        dependsOn: ['root'],
      }),
    };
    const result = buildGraph(steps, 'root');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('my-data');
  });
});

// ---------------------------------------------------------------------------
// concurrent ask steps in parallel barrier (compile-time rejection)
// ---------------------------------------------------------------------------

describe('concurrent ask steps in parallel barrier (compile-time rejection)', () => {
  it('two ask steps in different branches of the same parallel step throw FlowDefinitionError', () => {
    expect(() =>
      defineFlow({
        name: 'parallel-two-asks',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fan: step.parallel({ branches: ['ask-a', 'ask-b'] }),
          'ask-a': step.ask({ questions: [{ id: 'q1', kind: 'text', label: 'Question A?' }] }),
          'ask-b': step.ask({ questions: [{ id: 'q2', kind: 'text', label: 'Question B?' }] }),
        },
        start: 'fan',
      }),
    ).toThrow(FlowDefinitionError);

    let caught: FlowDefinitionError | undefined;
    try {
      defineFlow({
        name: 'parallel-two-asks',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fan: step.parallel({ branches: ['ask-a', 'ask-b'] }),
          'ask-a': step.ask({ questions: [{ id: 'q1', kind: 'text', label: 'Question A?' }] }),
          'ask-b': step.ask({ questions: [{ id: 'q2', kind: 'text', label: 'Question B?' }] }),
        },
        start: 'fan',
      });
    } catch (e) {
      caught = e as FlowDefinitionError;
    }
    expect(caught).toBeInstanceOf(FlowDefinitionError);
    expect(caught?.message).toContain('fan');
    expect(caught?.message).toContain('ask-a');
    expect(caught?.message).toContain('ask-b');
    expect(caught?.message).toContain('concurrent asks are not supported');
  });

  it('one ask step in one branch and one non-ask step in the other branch succeeds', () => {
    expect(() =>
      defineFlow({
        name: 'parallel-one-ask-one-prompt',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fan: step.parallel({ branches: ['gather', 'analyze'] }),
          gather: step.ask({ questions: [{ id: 'q1', kind: 'text', label: 'Name?' }] }),
          analyze: step.prompt({ promptFile: 'analyze.md', output: { handoff: 'analysis' } }),
        },
        start: 'fan',
      }),
    ).not.toThrow();
  });

  it('ask step inside a loop body inside a parallel branch AND another ask in a sibling branch throw FlowDefinitionError', () => {
    expect(() =>
      defineFlow({
        name: 'parallel-loop-ask-and-sibling-ask',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          fan: step.parallel({ branches: ['loop-branch', 'direct-ask'] }),
          'loop-branch': step.loop({
            body: {
              'inner-ask': step.ask({
                questions: [{ id: 'q1', kind: 'text', label: 'Inner question?' }],
              }),
              'inner-prompt': step.prompt({
                promptFile: 'inner.md',
                dependsOn: ['inner-ask'],
                output: { handoff: 'loop-done' },
              }),
            },
            until: { from: 'loop-done', when: { status: 'done' } },
            maxIterations: 5,
            start: 'inner-ask',
          }),
          'direct-ask': step.ask({
            questions: [{ id: 'q2', kind: 'text', label: 'Direct question?' }],
          }),
        },
        start: 'fan',
      }),
    ).toThrow(FlowDefinitionError);
  });

  it('ask step inside a loop body with no parallel ancestor succeeds', () => {
    expect(() =>
      defineFlow({
        name: 'loop-ask-no-parallel',
        version: '0.0.1',
        input: z.object({}),
        steps: {
          'my-loop': step.loop({
            body: {
              'body-ask': step.ask({
                questions: [{ id: 'q1', kind: 'text', label: 'Iteration question?' }],
              }),
              'body-prompt': step.prompt({
                promptFile: 'body.md',
                dependsOn: ['body-ask'],
                output: { handoff: 'body-done' },
              }),
            },
            until: { from: 'body-done', when: { status: 'done' } },
            maxIterations: 3,
            start: 'body-ask',
          }),
        },
      }),
    ).not.toThrow();
  });
});
