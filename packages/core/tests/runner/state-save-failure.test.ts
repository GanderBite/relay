import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hoisted counter + target pattern so the vi.mock factory reaches them. Each
// test sets `failStateSave.target` to the runDir and `failStateSave.failAfter`
// to the number of successful state.json rename calls to let through before
// the next one rejects with a synthetic I/O error. Setting target to null
// disables the injection.
const failStateSave = vi.hoisted(() => ({
  target: null as string | null,
  failAfter: 0,
  seen: 0,
  consumed: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    async rename(
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) {
      const dstStr = typeof dst === 'string' ? dst : dst.toString();
      const target = failStateSave.target;
      if (
        target !== null &&
        dstStr === join(target, 'state.json') &&
        !failStateSave.consumed
      ) {
        if (failStateSave.seen >= failStateSave.failAfter) {
          failStateSave.consumed = true;
          throw Object.assign(new Error('injected state.json rename failure'), {
            code: 'EIO',
          });
        }
        failStateSave.seen += 1;
      }
      return actual.rename(src, dst);
    },
  };
});

import { createRunner } from '../../src/runner/runner.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { StateWriteError } from '../../src/errors.js';
import { z } from '../../src/zod.js';
import type { InvocationResponse } from '../../src/providers/types.js';

const canned: InvocationResponse = {
  text: 'ok',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function twoStepFlow() {
  return defineFlow({
    name: 'two-step',
    version: '0.1.0',
    input: z.object({}),
    steps: {
      a: step.prompt({
        promptFile: 'p.md',
        output: { handoff: 'a-out' },
      }),
      b: step.prompt({
        promptFile: 'p.md',
        dependsOn: ['a'],
        output: { handoff: 'b-out' },
      }),
    },
  });
}

describe('Runner — state save failure escalation', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-state-save-fail-'));
    failStateSave.target = null;
    failStateSave.failAfter = 0;
    failStateSave.seen = 0;
    failStateSave.consumed = false;
  });

  afterEach(async () => {
    failStateSave.target = null;
    failStateSave.failAfter = 0;
    failStateSave.seen = 0;
    failStateSave.consumed = false;
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects with StateWriteError when an early run-level save fails and does not resolve as succeeded', async () => {
    // StateMachine.init() renames state.json once before the runner's explicit
    // initialSave runs. failAfter=1 lets the init write through and trips the
    // initialSave — an early-path write failure that must surface as a
    // rejected Runner.run() promise, not a silent success.
    failStateSave.target = tmp;
    failStateSave.failAfter = 1;

    const provider = new MockProvider({ responses: { a: canned, b: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({
      providers: registry,
      runDir: tmp,
    });

    const thrown = await runner.run(twoStepFlow(), {}, { flagProvider: 'mock' }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(StateWriteError);
    expect(failStateSave.consumed).toBe(true);
  });

  it('rejects with StateWriteError when the step startSave fails and does not hang', async () => {
    // StateMachine.init() renames state.json once and the explicit initialSave
    // renames it once more before the walker dispatches any step. failAfter=2
    // lets those two pre-execution writes through and trips step-a's startSave
    // — the first save that runs inside dispatchStep. The leak guarded here:
    // if dispatchStep reserved an inflight slot before the save, the walker
    // would hang waiting on a phantom in-flight count after the error drains
    // into the completions queue. This test asserts the rejection surfaces
    // within the vitest per-test timeout instead of requiring the fallback.
    failStateSave.target = tmp;
    failStateSave.failAfter = 2;

    const provider = new MockProvider({ responses: { a: canned, b: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({
      providers: registry,
      runDir: tmp,
    });

    const thrown = await runner.run(twoStepFlow(), {}, { flagProvider: 'mock' }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(StateWriteError);
    expect(failStateSave.consumed).toBe(true);
  }, 5_000);

  it('rejects with StateWriteError when the walker completion save fails', async () => {
    // StateMachine.init() + the explicit initialSave after input validation
    // both rename state.json before any step dispatches. Then step-a's
    // startSave runs. failAfter=3 lets those three pre-execution writes
    // through and trips the next write — the walker's post-completion save
    // after step-a ran successfully.
    failStateSave.target = tmp;
    failStateSave.failAfter = 3;

    const bSpy = vi.fn(() => canned);
    const provider = new MockProvider({ responses: { a: canned, b: bSpy } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({
      providers: registry,
      runDir: tmp,
    });

    const outcome = await runner
      .run(twoStepFlow(), {}, { flagProvider: 'mock' })
      .then((value) => ({ kind: 'resolved' as const, value }))
      .catch((error: unknown) => ({ kind: 'rejected' as const, error }));

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(StateWriteError);
    }
    expect(failStateSave.consumed).toBe(true);
  });
});
