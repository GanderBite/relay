import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hoisted knob so the vi.mock factory can reach it. When `target` is the
// runDir of a test in progress, the next rename against `<target>/state.json`
// after `failAfter` successful writes throws a synthetic I/O error. That
// forces the Runner's walker to throw before reaching its normal exit — the
// exact path where an orphaned abort listener is observable.
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
import { z } from '../../src/zod.js';
import type { InvocationResponse } from '../../src/providers/types.js';

const canned: InvocationResponse = {
  text: '{"ok":true}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

function twoStepFlow() {
  return defineFlow({
    name: 'abort-listener-cleanup-flow',
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

describe('Runner — abort listener cleanup', () => {
  let tmp: string;
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-abort-listener-'));
    failStateSave.target = null;
    failStateSave.failAfter = 0;
    failStateSave.seen = 0;
    failStateSave.consumed = false;
    // Spying on AbortSignal.prototype catches every abort-event registration
    // and removal the Runner performs, regardless of which AbortController the
    // run happens to allocate. The test asserts the balance of pairs, which
    // stays zero only when every addEventListener has a matching removal.
    addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
  });

  afterEach(async () => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
    failStateSave.target = null;
    failStateSave.failAfter = 0;
    failStateSave.seen = 0;
    failStateSave.consumed = false;
    await rm(tmp, { recursive: true, force: true });
  });

  // Vitest's own test runner registers a nameless `abort` listener on its
  // internal AbortSignal for timeout/cancellation, and its prototype spy picks
  // that up too. Filter by the named handlers the Runner installs so the
  // assertion targets the Runner's listener hygiene, not vitest's bookkeeping.
  const RUNNER_HANDLER_NAMES = new Set(['onAbort', 'abortHandler']);

  function countRunnerAbortCalls(spy: ReturnType<typeof vi.spyOn>): number {
    let n = 0;
    for (const call of spy.mock.calls) {
      if (call[0] !== 'abort') continue;
      const handler = call[1];
      if (typeof handler !== 'function') continue;
      if (RUNNER_HANDLER_NAMES.has(handler.name)) n += 1;
    }
    return n;
  }

  function countOnAbortCalls(spy: ReturnType<typeof vi.spyOn>): number {
    let n = 0;
    for (const call of spy.mock.calls) {
      if (call[0] !== 'abort') continue;
      const handler = call[1];
      if (typeof handler !== 'function') continue;
      if (handler.name === 'onAbort') n += 1;
    }
    return n;
  }

  it('removes the walker abort listener exactly once when the walker throws mid-run', async () => {
    // StateMachine.init() + the explicit initialSave after input validation
    // both rename state.json before any step dispatches. The next write is
    // step-a's startSave. failAfter=3 lets those three pre-walker writes
    // through and trips the first save inside the walker — the path that
    // orphaned the abort listener before the try/finally was introduced.
    failStateSave.target = tmp;
    failStateSave.failAfter = 3;

    const provider = new MockProvider({ responses: { a: canned, b: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({
      providers: registry,
      defaultProvider: 'mock',
      runDir: tmp,
    });

    const thrown = await runner.run(twoStepFlow(), {}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(failStateSave.consumed).toBe(true);

    // The walker registers exactly one `onAbort` listener per run and must
    // remove it even when save() throws before the normal return path. The
    // assertion on the scoped helper's count is separate from the specific
    // claim this task exercises — the walker-owned listener is the one that
    // was leaking before the try/finally wrap.
    const onAbortAdds = countOnAbortCalls(addSpy);
    const onAbortRemoves = countOnAbortCalls(removeSpy);
    expect(onAbortAdds).toBe(1);
    expect(onAbortRemoves).toBe(1);

    // Every Runner-owned abort-event registration must be paired with a
    // removal. Adds == removes holds for both the walker's listener and the
    // per-call raceAbort listeners.
    const adds = countRunnerAbortCalls(addSpy);
    const removes = countRunnerAbortCalls(removeSpy);
    expect(adds).toBeGreaterThan(0);
    expect(removes).toBe(adds);
  });

  it('removes the walker abort listener exactly once on a clean success', async () => {
    // The prompt executor resolves promptFile relative to flowDir, so the
    // run would otherwise fail with ENOENT on step a. Pointing flowDir at tmp
    // and dropping a minimal template keeps the happy path on the success
    // branch this assertion needs to exercise.
    await writeFile(join(tmp, 'p.md'), 'hello', 'utf8');

    const provider = new MockProvider({ responses: { a: canned, b: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const runner = createRunner({
      providers: registry,
      defaultProvider: 'mock',
      runDir: tmp,
    });

    const result = await runner.run(twoStepFlow(), {}, { flowDir: tmp });
    expect(result.status).toBe('succeeded');

    const onAbortAdds = countOnAbortCalls(addSpy);
    const onAbortRemoves = countOnAbortCalls(removeSpy);
    expect(onAbortAdds).toBe(1);
    expect(onAbortRemoves).toBe(1);

    const adds = countRunnerAbortCalls(addSpy);
    const removes = countRunnerAbortCalls(removeSpy);
    expect(adds).toBeGreaterThan(0);
    expect(removes).toBe(adds);
  });
});
