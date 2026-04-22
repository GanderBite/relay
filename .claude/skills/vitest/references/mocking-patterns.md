# Mocking Patterns

Vitest's mocking surface is similar to Jest's but ESM-aware. The patterns that matter for Relay tests:

## `vi.mock` — full module mock

```ts
import { vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Now any import of that module gets the mock.
import { query } from '@anthropic-ai/claude-agent-sdk';

it('uses the mock', () => {
  vi.mocked(query).mockReturnValue(/* ... */);
});
```

**Hoisting:** `vi.mock()` is hoisted to the top of the file. The factory must not reference top-level variables — it runs before the module body. If you need to share a fixture, use `vi.hoisted()`:

```ts
const { mockResponse } = vi.hoisted(() => ({
  mockResponse: { text: 'mocked' },
}));

vi.mock('./response.js', () => ({
  getResponse: () => mockResponse,
}));
```

## `vi.mock` with partial — keep some real

```ts
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),   // override only spawn; exec, fork, etc. stay real
  };
});
```

Useful when the real module has things you DON'T want to break (constants, helpers) but a single function you want to control.

## `vi.spyOn` — wrap an existing function

```ts
import * as fsPromises from 'node:fs/promises';

it('writes to atomicWriteJson', async () => {
  const renameSpy = vi.spyOn(fsPromises, 'rename');
  await atomicWriteJson('/tmp/x.json', { a: 1 });
  expect(renameSpy).toHaveBeenCalledOnce();
  renameSpy.mockRestore();
});
```

`spyOn` lets the real function run while observing calls. To replace the implementation:

```ts
const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async () => { /* ... */ });
```

## `vi.fn` — bare mock function

```ts
const dispatch = vi.fn(async (runnerId: string) => ({ ok: true }));
await executeParallel(runner, ctx, dispatch);
expect(dispatch).toHaveBeenCalledWith('entities');
expect(dispatch).toHaveBeenCalledWith('services');
```

Use for callbacks injected via parameters.

## Mock return value patterns

```ts
mockReturnValue(x);           // every call returns x
mockReturnValueOnce(x);       // next call returns x, then back to default
mockResolvedValue(x);         // async — every call returns Promise.resolve(x)
mockResolvedValueOnce(x);     // async, one-shot
mockRejectedValue(err);       // async — every call rejects
mockRejectedValueOnce(err);   // async, one-shot

// Chained queue:
fn.mockResolvedValueOnce('first')
  .mockResolvedValueOnce('second')
  .mockResolvedValue('default');
```

## Mock implementation

```ts
const fn = vi.fn().mockImplementation((runnerId: string) => {
  if (runnerId === 'fail-me') throw new Error('synthetic');
  return { ok: true };
});
```

Use when the response depends on the input.

## Async iterator mocks (for SDK streams)

```ts
function mkAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

vi.mocked(query).mockReturnValue(mkAsyncIterable([
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
  { type: 'message_stop', usage: { input_tokens: 10, output_tokens: 5 } },
]) as any);
```

The SDK's `query()` returns an async iterator. Tests of the translator and the provider need this shape.

## Partial mocks via `vi.importActual`

If `vi.mock` factory hoisting causes problems, use `importActual` inside the factory:

```ts
vi.mock('@relay/core', async () => {
  const actual = await vi.importActual<typeof import('@relay/core')>('@relay/core');
  return {
    ...actual,
    Runner: class FakeRunner { /* ... */ },
  };
});
```

## Resetting between tests

```ts
afterEach(() => {
  vi.restoreAllMocks();   // restores spies; resets mocks created via vi.fn()
  vi.clearAllMocks();     // clears mock.calls / mock.results without removing implementations
  vi.resetAllMocks();     // resets implementations to no-op (next call returns undefined)
});
```

The default in `vitest.config.ts` `clearMocks: true` runs `clearAllMocks` automatically before every test. Combine with `restoreMocks: true` to also restore spies. We recommend both.

## Anti-patterns

- **Don't mock fs without a temp dir.** Real fs in a temp dir is more reliable than mock fs that doesn't capture all the edge cases.
- **Don't mock @relay/core types.** Use the real types; mock only the runtime functions you don't want to invoke.
- **Don't forget to import the mocked function AFTER `vi.mock`.** Hoisting means the import runs after the mock, but humans read top-to-bottom.
- **Don't leave `console.log` in mock implementations.** They run in tests; the noise pollutes CI output.
