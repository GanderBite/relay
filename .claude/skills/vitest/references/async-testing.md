# Async Testing

Most of the Relay test surface is async — the Runner, Provider, HandoffStore, atomic writes. Getting async testing right matters more than getting any other test pattern right.

## Always `await`

```ts
// ✅
it('writes a handoff', async () => {
  const result = await store.write('inv', { ok: true });
  expect(result).toBeUndefined();
});

// ❌ Returns a promise that's never awaited — test passes even if write throws
it('writes a handoff', () => {
  store.write('inv', { ok: true });
  expect(true).toBe(true);
});
```

Vitest will warn about un-awaited promises in some cases, but not all. Don't rely on the warning.

## `expect.resolves` / `expect.rejects`

```ts
// ✅ Both forms — pick the one that reads cleaner
await expect(store.write('inv', { ok: true })).resolves.toBeUndefined();
await expect(inspectClaudeAuth({})).rejects.toThrow(ClaudeAuthError);

// ❌ Forgot to await — passes even if the promise rejects
expect(store.write('inv', { ok: true })).resolves.toBeUndefined();
```

The `await` in front is mandatory. Without it, the matcher returns a promise that never resolves into the test.

## Fake timers

```ts
import { vi } from 'vitest';

it('retries with backoff', async () => {
  vi.useFakeTimers();
  try {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 1, baseDelayMs: 100, /* ... */ });
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
```

Key facts:

- `vi.useFakeTimers()` replaces `setTimeout`, `setInterval`, `Date.now`, `process.nextTick`.
- `vi.advanceTimersByTimeAsync(ms)` advances the fake clock and runs any pending microtasks. Use this; the synchronous version (`advanceTimersByTime`) doesn't drain promises.
- Always restore in a `finally` or `afterEach`. Leaked fake timers break unrelated tests.

## Testing AbortSignal-aware code

```ts
it('aborts mid-stream', async () => {
  const controller = new AbortController();
  const provider = new MockProvider({
    responses: {
      slow: async (req, ctx) => {
        await new Promise((resolve, reject) => {
          ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason));
        });
        return mkResponse('done');
      },
    },
  });

  const promise = provider.invoke({ prompt: 'hi' }, makeCtx({ abortSignal: controller.signal }));
  setTimeout(() => controller.abort(new Error('user cancelled')), 10);
  await expect(promise).rejects.toThrow('user cancelled');
});
```

The pattern: pass an AbortController.signal as `ctx.abortSignal`, then assert that aborting it propagates.

## Race conditions

For testing concurrency-sensitive code (parallel step executor, state machine writes), use `Promise.all` and assert behavior under interleaving:

```ts
it('serializes concurrent state writes', async () => {
  const sm = new StateMachine(runDir, 'flow', '0.1.0', 'run1', {});
  await sm.init(['a', 'b', 'c']);

  // Fire all three completions simultaneously
  await Promise.all([
    sm.completeStep('a'),
    sm.completeStep('b'),
    sm.completeStep('c'),
  ]);

  const state = await loadState(runDir);
  expect(state.steps.a.status).toBe('succeeded');
  expect(state.steps.b.status).toBe('succeeded');
  expect(state.steps.c.status).toBe('succeeded');
});
```

If state writes aren't serialized correctly, this catches the corrupted file.

## Async iterator tests

```ts
it('yields text deltas in order', async () => {
  const events: InvocationEvent[] = [];
  for await (const evt of provider.stream(req, ctx)) {
    events.push(evt);
  }
  const deltas = events.filter(e => e.type === 'text.delta').map(e => (e as any).delta);
  expect(deltas.join('')).toBe('hello world');
});
```

Always drain the iterator. Breaking out early can leave subprocess handles dangling.

## Timeouts on tests themselves

The default test timeout is 10 seconds (set in `vitest.config.ts`). For inherently long tests, override per-test:

```ts
it('runs a 5-step flow', { timeout: 30_000 }, async () => {
  // ...
});
```

But: a test that takes more than a few seconds is suspicious. Either it's doing real I/O it shouldn't (mock it), or it's exposing a real performance issue.

## Detecting unhandled rejections

```ts
// vitest.config.ts
test: {
  unhandledRejections: 'strict',   // fails the test on any unhandled rejection
}
```

This catches the case where you fire-and-forget a promise that later rejects.

## Common failure modes

| Symptom | Cause |
|---|---|
| Test passes but actually fails | Forgot `await` on assertion |
| Test hangs until timeout | Awaited a promise that never resolves (often a forgotten resolver in a mock) |
| Flaky pass/fail | Real time-based code without fake timers; or shared state between tests |
| "Cannot read property of undefined" mid-test | Mock factory hoisting — your imports happen after the mock, but referenced data isn't initialized when the factory runs (use `vi.hoisted`) |
| Passes locally, fails in CI | Implicit dependency on the local filesystem, env, or a port |

## Anti-patterns

- **No `setTimeout` in tests** without `vi.useFakeTimers`. Real waits are flaky.
- **No real network.** Mock fetch.
- **No real Claude calls.** MockProvider only.
- **No promise chains.** `async/await` is clearer; the linter should flag `.then()`.
- **No leaked state between tests.** Every `beforeEach` initializes; every `afterEach` tears down.
