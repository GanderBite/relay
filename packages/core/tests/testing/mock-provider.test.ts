import { describe, it, expect } from 'vitest';

import { MockProvider } from '../../src/testing/mock-provider.js';
import { RunnerFailureError } from '../../src/errors.js';
import type {
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
} from '../../src/providers/types.js';
import type { Logger } from '../../src/logger.js';

function makeLogger(): Logger {
  const noop = (): void => undefined;
  const stub: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    level: 'silent',
  };
  stub.child = function child(): Logger {
    return this as unknown as Logger;
  };
  return stub as unknown as Logger;
}

function makeCtx(runnerId: string, attempt = 1): InvocationContext {
  return {
    raceName: 'f',
    runId: 'r',
    runnerId,
    attempt,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
  };
}

function makeReq(prompt = 'hello', model = 'mock'): InvocationRequest {
  return { prompt, model };
}

const canned: InvocationResponse = {
  text: 'ok',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('MockProvider', () => {
  it('[MOCK-001] invoke returns the configured response for a known runnerId', async () => {
    const p = new MockProvider({ responses: { inventory: canned } });
    const r = await p.invoke(makeReq(), makeCtx('inventory'));
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().text).toBe('ok');
    expect(r._unsafeUnwrap().usage.inputTokens).toBe(10);
  });

  it('[MOCK-002] invoke with unknown runnerId returns err(RunnerFailureError)', async () => {
    const p = new MockProvider({ responses: { known: canned } });
    const r = await p.invoke(makeReq(), makeCtx('unknownStep', 2));
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(RunnerFailureError);
    if (err instanceof RunnerFailureError) {
      expect(err.runnerId).toBe('unknownStep');
      expect(err.attempt).toBe(2);
    }
  });

  it('[MOCK-003] stream with unknown runnerId throws RunnerFailureError', async () => {
    const p = new MockProvider({ responses: { known: canned } });
    let thrown: unknown;
    try {
      for await (const _evt of p.stream(makeReq(), makeCtx('unknownStep'))) {
        // unreachable
        void _evt;
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunnerFailureError);
  });

  it('[MOCK-004] stream yields turn.start, text.delta, usage, turn.end, stream.end in order', async () => {
    const response: InvocationResponse = { ...canned, text: 'hello', numTurns: 1 };
    const p = new MockProvider({ responses: { s: response } });
    const events = [];
    for await (const e of p.stream(makeReq(), makeCtx('s'))) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'turn.start',
      'text.delta',
      'usage',
      'turn.end',
      'stream.end',
    ]);
    expect(events[0]).toMatchObject({ type: 'turn.start', turn: 1 });
    expect(events[1]).toMatchObject({ type: 'text.delta', delta: 'hello' });
    expect(events[3]).toMatchObject({ type: 'turn.end', turn: response.numTurns });
    expect(events[4]).toMatchObject({ type: 'stream.end', stopReason: 'end_turn' });
  });

  it('[MOCK-005] callable response receives InvocationRequest and InvocationContext', async () => {
    let captured: { req: InvocationRequest; ctx: InvocationContext } | undefined;
    const p = new MockProvider({
      responses: {
        s: (req, ctx) => {
          captured = { req, ctx };
          return canned;
        },
      },
    });
    const req = makeReq('hi', 'sonnet');
    const ctx = makeCtx('s');
    const r = await p.invoke(req, ctx);
    expect(r.isOk()).toBe(true);
    expect(captured?.req.prompt).toBe('hi');
    expect(captured?.req.model).toBe('sonnet');
    expect(captured?.ctx.runnerId).toBe('s');
  });
});
