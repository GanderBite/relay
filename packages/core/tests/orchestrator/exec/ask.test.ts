import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AwaitingInputSignal,
  HandoffNotFoundError,
  HandoffSchemaError,
} from '../../../src/errors.js';
import type { AskStepSpec } from '../../../src/flow/types.js';
import { HandoffStore } from '../../../src/handoffs.js';
import {
  askAnswerHandoffKey,
  askAnswerHandoffPath,
  executeAsk,
} from '../../../src/orchestrator/exec/ask.js';
import { atomicWriteJson } from '../../../src/util/atomic-write.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEXT_QUESTION = { id: 'q1', kind: 'text' as const, label: 'Your name?' };
const SELECT_QUESTION = {
  id: 'q2',
  kind: 'select' as const,
  label: 'Pick one',
  options: ['a', 'b'],
};

function makeStaticSpec(stepId: string): AskStepSpec {
  return {
    id: stepId,
    kind: 'ask',
    questions: [TEXT_QUESTION, SELECT_QUESTION],
  };
}

function makeDynamicSpec(stepId: string, from: string): AskStepSpec {
  return {
    id: stepId,
    kind: 'ask',
    questions: { from },
  };
}

describe('askAnswerHandoffKey', () => {
  it('produces an underscore-prefixed key from the step id', () => {
    expect(askAnswerHandoffKey('gather')).toBe('__ask_gather__');
    expect(askAnswerHandoffKey('my-step')).toBe('__ask_my-step__');
  });
});

describe('askAnswerHandoffPath', () => {
  it('resolves the answer file path under the run directory', () => {
    const path = askAnswerHandoffPath('/run', 'gather');
    expect(path).toBe(join('/run', 'handoffs', '__ask_gather__.json'));
  });
});

describe('executeAsk', () => {
  let tmp: string;
  let store: HandoffStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-ask-'));
    store = new HandoffStore(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // First-pass path (answer file not present): throws AwaitingInputSignal.
  // -----------------------------------------------------------------------

  it('static questions: throws AwaitingInputSignal carrying step id and questions', async () => {
    const spec = makeStaticSpec('gather');

    await expect(executeAsk(spec, store, 'gather', tmp)).rejects.toBeInstanceOf(
      AwaitingInputSignal,
    );

    try {
      await executeAsk(spec, store, 'gather', tmp);
    } catch (caught) {
      expect(caught).toBeInstanceOf(AwaitingInputSignal);
      const signal = caught as AwaitingInputSignal;
      expect(signal.stepId).toBe('gather');
      expect(signal.questions).toEqual([TEXT_QUESTION, SELECT_QUESTION]);
    }
  });

  it('dynamic question source: reads questions then throws AwaitingInputSignal', async () => {
    await store.write('question-source', [TEXT_QUESTION]);
    const spec = makeDynamicSpec('gather', 'question-source');

    try {
      await executeAsk(spec, store, 'gather', tmp);
      throw new Error('expected AwaitingInputSignal');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AwaitingInputSignal);
      const signal = caught as AwaitingInputSignal;
      expect(signal.stepId).toBe('gather');
      expect(signal.questions).toEqual([TEXT_QUESTION]);
    }
  });

  it('dynamic source missing: returns err(HandoffNotFoundError)', async () => {
    const spec = makeDynamicSpec('gather', 'no-such-source');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error('expected err');
    expect(result.error).toBeInstanceOf(HandoffNotFoundError);
  });

  it('empty static questions list: throws AwaitingInputSignal with empty questions array', async () => {
    const spec: AskStepSpec = { id: 'gather', kind: 'ask', questions: [] };
    try {
      await executeAsk(spec, store, 'gather', tmp);
      throw new Error('expected AwaitingInputSignal');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AwaitingInputSignal);
      const signal = caught as AwaitingInputSignal;
      expect(signal.questions).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // Resume path (answer file present): returns ok(answerMap).
  // -----------------------------------------------------------------------

  it('answer file present via atomicWriteJson: returns ok(answerMap)', async () => {
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    const writeResult = await atomicWriteJson(answerPath, { q1: 'Alice', q2: 'a' });
    expect(writeResult.isOk()).toBe(true);

    const spec = makeStaticSpec('gather');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw new Error('expected ok');
    expect(result.value).toEqual({ q1: 'Alice', q2: 'a' });
  });

  it('answer file present via raw writeFile: returns ok(answerMap)', async () => {
    const handoffsDir = join(tmp, 'handoffs');
    await mkdir(handoffsDir, { recursive: true });
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await writeFile(answerPath, JSON.stringify({ q1: 'Bob', q2: 'b' }), 'utf8');

    const spec = makeStaticSpec('gather');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw new Error('expected ok');
    expect(result.value).toEqual({ q1: 'Bob', q2: 'b' });
  });

  it('answer file with empty object: returns ok({})', async () => {
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await atomicWriteJson(answerPath, {});

    const spec = makeStaticSpec('gather');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw new Error('expected ok');
    expect(result.value).toEqual({});
  });

  it('malformed answer file (non-JSON bytes): returns err(HandoffSchemaError)', async () => {
    const handoffsDir = join(tmp, 'handoffs');
    await mkdir(handoffsDir, { recursive: true });
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await writeFile(answerPath, 'not valid json{{', 'utf8');

    const spec = makeStaticSpec('gather');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error('expected err');
    expect(result.error).toBeInstanceOf(HandoffSchemaError);
    expect(result.error.handoffId).toBe(askAnswerHandoffKey('gather'));
  });

  it('answer file with non-object JSON: returns err(HandoffSchemaError)', async () => {
    const handoffsDir = join(tmp, 'handoffs');
    await mkdir(handoffsDir, { recursive: true });
    const answerPath = askAnswerHandoffPath(tmp, 'gather');
    await writeFile(answerPath, JSON.stringify(['not', 'an', 'object']), 'utf8');

    const spec = makeStaticSpec('gather');
    const result = await executeAsk(spec, store, 'gather', tmp);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error('expected err');
    expect(result.error).toBeInstanceOf(HandoffSchemaError);
  });

  it('every step id triggers AwaitingInputSignal on the first pass', async () => {
    const stepIds = ['a', 'gather', 'my-step', 'step123'];
    for (const stepId of stepIds) {
      const spec = makeStaticSpec(stepId);
      try {
        await executeAsk(spec, store, stepId, tmp);
        throw new Error(`expected AwaitingInputSignal for stepId '${stepId}'`);
      } catch (caught) {
        expect(caught).toBeInstanceOf(AwaitingInputSignal);
      }
    }
  });
});
