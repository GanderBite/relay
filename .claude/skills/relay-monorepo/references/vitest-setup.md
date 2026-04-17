# Vitest Setup — Per Package

Vitest is the test runner across all Relay packages. Vitest is Vite-based, ESM-native, fast, and shares config syntax with the rest of the modern TS ecosystem.

## Install (already in dev deps if you used the canonical package.json)

```bash
pnpm -F @relay/core add -D vitest @vitest/coverage-v8
```

## `vitest.config.ts`

```ts
// packages/core/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,                    // enables describe/it/expect without imports
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/testing/**',           // MockProvider isn't covered by its own tests
        'src/index.ts',             // re-exports only
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
```

The 80% threshold matches the M1 acceptance for `@relay/core`. Other packages can relax this.

## Test layout

```
packages/core/
├── src/
│   ├── errors.ts
│   ├── runner/runner.ts
│   └── ...
└── tests/
    ├── errors.test.ts
    ├── runner/runner.test.ts
    └── ...
```

Mirror the `src/` tree under `tests/`. One test file per source file is the default — split when a single test file gets unwieldy.

## Test scripts in package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

CI uses `vitest run --coverage`. Local dev uses `vitest` (watch mode by default).

## Useful Vitest patterns for Relay

### Temp directory per test

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

### Mock environment variables

```ts
import { vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'test-token');
  vi.stubEnv('ANTHROPIC_API_KEY', '');   // explicitly unset
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

### Mock child_process for the auth binary check

```ts
import { vi } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
}));

// In test:
vi.mocked(childProcess.spawn).mockReturnValue({
  on: (event: string, cb: any) => {
    if (event === 'exit') setImmediate(() => cb(0));
  },
  stdout: { on: () => {} },
  stderr: { on: () => {} },
} as any);
```

### MockProvider in runner tests

```ts
import { MockProvider } from '@relay/core/testing';
import { ProviderRegistry, createRunner, defineFlow, step, z } from '@relay/core';

it('runs a 2-step flow against MockProvider', async () => {
  const provider = new MockProvider({
    responses: {
      first: { text: 'hello', usage: zero, costUsd: 0, durationMs: 0, numTurns: 1, model: 'mock', stopReason: 'end_turn' },
      second: { text: '{"x":1}', usage: zero, costUsd: 0, durationMs: 0, numTurns: 1, model: 'mock', stopReason: 'end_turn' },
    },
  });
  const registry = new ProviderRegistry();
  registry.register(provider);

  const flow = defineFlow({
    name: 'two-step',
    version: '0.0.1',
    input: z.object({}),
    steps: {
      first: step.prompt({ promptFile: 'prompts/01.md', output: { artifact: 'a.txt' } }),
      second: step.prompt({ promptFile: 'prompts/02.md', dependsOn: ['first'], output: { handoff: 'h' } }),
    },
  });

  const runner = createRunner({ providers: registry, defaultProvider: 'mock', runDir });
  const result = await runner.run(flow, {});
  expect(result.status).toBe('succeeded');
});
```

### Snapshot testing for CLI output

```ts
import { renderStartBanner } from '../src/banner.js';

it('matches the §6.3 banner format', () => {
  const out = renderStartBanner({
    flow: { name: 'codebase-discovery', version: '0.1.0' },
    runId: 'f9c3a2',
    auth: { ok: true, billingSource: 'subscription', detail: 'max via OAuth' },
    input: { repoPath: '.', audience: 'both' },
    costEstimate: { min: 0.30, max: 0.50 },
    stepCount: 5,
    etaMin: 12,
  });
  expect(out).toMatchSnapshot();
});
```

Snapshots live in `tests/__snapshots__/`. Commit them. Update with `pnpm test -u`.

## Anti-patterns

- **No live network calls.** Mock the SDK, mock fetch.
- **No live Claude calls.** MockProvider only.
- **No `setTimeout` waits.** Use `vi.useFakeTimers` for time-dependent code.
- **No reaching into private state.** Test the public surface; if you can't, it's a sign the module needs a smaller seam.
