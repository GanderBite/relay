---
name: vitest
description: Vitest testing patterns for the Relay codebase — describe/it structure, async/await tests, the MockProvider pattern (no live Claude calls), env stubbing for the auth guard tests, child_process mocking, snapshot testing for CLI banner output, fake timers for time-dependent code, and the temp-dir fixture for filesystem tests. Trigger this skill when writing or maintaining any `tests/**/*.test.ts` file across `@relay/core`, `@relay/cli`, `@relay/generator`, or any race package. Pair with the `relay-monorepo` skill for the per-package vitest config.
---

# Vitest Testing Patterns

Every Relay package uses Vitest. Tests live in `tests/` next to `src/`. Coverage target on `@relay/core` is **80% lines** (M1 acceptance).

## File layout

```
packages/core/
├── src/
│   ├── errors.ts
│   ├── runner/runner.ts
│   └── providers/claude/auth.ts
└── tests/
    ├── errors.test.ts
    ├── runner/runner.test.ts
    └── providers/claude/auth.test.ts
```

Mirror the `src/` tree. One test file per source file is the default.

## Basic shape

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Runner } from '../src/runner/runner.js';

describe('Runner', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('runs a 2-step flow against MockProvider', async () => {
    // ...
    expect(result.status).toBe('succeeded');
  });
});
```

`globals: true` in `vitest.config.ts` lets you skip the imports if you prefer; we keep them for clarity.

## The MockProvider pattern (the most important pattern)

**Never call the real Claude SDK from a test.** Use `MockProvider` from `@relay/core/testing`.

```ts
import { MockProvider } from '@relay/core/testing';
import { ProviderRegistry, createOrchestrator, defineRace, runner, z } from '@relay/core';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function mkResponse(text: string) {
  return { text, usage: ZERO_USAGE, costUsd: 0, durationMs: 1, numTurns: 1, model: 'mock', stopReason: 'end_turn' };
}

it('runs end-to-end', async () => {
  const provider = new MockProvider({
    responses: {
      first: mkResponse('hello'),
      second: mkResponse('{"ok": true}'),
    },
  });
  const registry = new ProviderRegistry();
  registry.register(provider);

  const race = defineRace({
    name: 'two-runner',
    version: '0.0.1',
    input: z.object({}),
    runners: {
      first: runner.prompt({ promptFile: 'p1.md', output: { artifact: 'out.txt' } }),
      second: runner.prompt({ promptFile: 'p2.md', dependsOn: ['first'], output: { baton: 'h' } }),
    },
  });

  const orchestrator = createOrchestrator({ providers: registry, defaultProvider: 'mock', runDir });
  const result = await orchestrator.run(race, {});
  expect(result.status).toBe('succeeded');
});
```

The MockProvider keys responses by step ID and throws a clear error if a step is invoked without a configured response.

## Env stubbing — for the auth guard tests

```ts
import { vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('RELAY_ALLOW_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('throws when ANTHROPIC_API_KEY is set without opt-in', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  await expect(inspectClaudeAuth({})).rejects.toThrow(ClaudeAuthError);
});

it('returns warning when opt-in via env', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  vi.stubEnv('RELAY_ALLOW_API_KEY', '1');
  const auth = await inspectClaudeAuth({});
  expect(auth.billingSource).toBe('api-account');
  expect(auth.warnings).toContain('billing to API account, not subscription');
});
```

Always reset in `afterEach`. A leaked env stub will silently corrupt later tests.

## Module mocking

```ts
import { vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

it('translates SDK messages to InvocationEvents', async () => {
  vi.mocked(query).mockReturnValue(mkAsyncIterable([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    { type: 'message_stop', usage: { input_tokens: 10, output_tokens: 5 } },
  ]));

  // exercise translator
});
```

Use `vi.mocked(fn)` for type-safe access to a mocked function's mock methods.

## child_process mocking — for the auth binary check

```ts
import { vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

beforeEach(() => {
  const fakeProc = new EventEmitter() as any;
  fakeProc.stdout = new EventEmitter();
  fakeProc.stderr = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(fakeProc);
  setImmediate(() => {
    fakeProc.stdout.emit('data', Buffer.from('claude 2.4.1\n'));
    fakeProc.emit('exit', 0);
  });
});
```

## Snapshot tests — for CLI output

```ts
import { renderStartBanner } from '../src/banner.js';

it('matches the §6.3 banner format', () => {
  const out = renderStartBanner({
    race: { name: 'codebase-discovery', version: '0.1.0' },
    runId: 'f9c3a2',
    auth: { ok: true, billingSource: 'subscription', detail: 'max via OAuth' },
    input: { repoPath: '.', audience: 'both' },
    costEstimate: { min: 0.30, max: 0.50 },
    runnerCount: 5,
    etaMin: 12,
  });
  expect(out).toMatchInlineSnapshot();   // first run fills it in
});
```

Use `toMatchInlineSnapshot()` over `toMatchSnapshot()` for CLI text — the snapshot lives in the test file, easier to review in PRs.

Update with `pnpm test -u`.

## Fake timers

```ts
import { vi } from 'vitest';

it('retries with backoff', async () => {
  vi.useFakeTimers();
  const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('ok');
  const promise = withRetry(fn, { maxRetries: 1, /* ... */ });
  await vi.advanceTimersByTimeAsync(100);
  await expect(promise).resolves.toBe('ok');
  expect(fn).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
```

Always `vi.useRealTimers()` in cleanup or via `afterEach` — leaked fake timers break unrelated async tests.

## Temp dir fixture

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});
```

Use this for any test that touches the filesystem. Never write into the project tree from a test.

## Async assertions

```ts
// ✅ Use await
const result = await someAsync();
expect(result).toBe('ok');

// ✅ Resolves / rejects matchers
await expect(somePromise).resolves.toBe('ok');
await expect(failingPromise).rejects.toThrow(ClaudeAuthError);

// ❌ Forgetting to await
expect(somePromise).resolves.toBe('ok');   // PASSES even if it rejects!
```

`expect.resolves` / `expect.rejects` MUST be awaited.

## Testing thrown errors

```ts
// ✅ Specific error class
await expect(fn()).rejects.toThrow(ClaudeAuthError);

// ✅ Error message substring
await expect(fn()).rejects.toThrow(/ANTHROPIC_API_KEY/);

// ✅ Both — instance + message
await expect(fn()).rejects.toThrow(expect.objectContaining({
  name: 'ClaudeAuthError',
  message: expect.stringContaining('ANTHROPIC_API_KEY'),
}));
```

## What to test (priorities for Relay)

1. **The auth guard.** Every branch of `inspectClaudeAuth`. Highest-stakes test surface in the codebase.
2. **The DAG cycle detector.** Cycles, missing dependencies, multi-root errors.
3. **The capability-negotiation matrix.** Every (runner requirement × provider capability) combination.
4. **Resume.** Run, kill, resume — verify succeeded runners don't re-execute.
5. **The CLI banner snapshots.** Every command's output against the product spec example.
6. **Atomic writes.** Concurrent writers don't corrupt the file.

## Anti-patterns

- **No live network.** No real `fetch`, no real `query()`, no real npm calls.
- **No `setTimeout`-based waits.** Use `vi.useFakeTimers` or wait on a specific promise.
- **No reaching into private state.** If you need to assert internal state, the public surface needs a smaller seam.
- **No `console.log` debugging left in.** Vitest captures stdout; leftover logs pollute CI output.
- **No tests of generated/scaffolded files** (templates) until the scaffolder is the system under test.

## References

- `references/mocking-patterns.md` — vi.mock, vi.spyOn, partial mocks, dynamic mock factories
- `references/snapshot-testing.md` — inline vs file snapshots, when to use which, snapshot review
- `references/async-testing.md` — Promise testing, fake timers, AbortSignal in tests, race conditions
