---
name: typescript
description: TypeScript 5.4+ patterns for the Relay codebase — strict mode discipline, ESM with NodeNext resolution, discriminated unions (used heavily in Runner types and InvocationEvent), Zod schema inference, type narrowing, branded types, the ban on `any` and `as` casts, and the import-extension rules ESM enforces. Trigger this skill when writing or refactoring any `.ts` file, when designing types for a new module, when the type system is fighting you, or when an agent is tempted to reach for `any` or `// @ts-ignore`.
---

# TypeScript Patterns for Relay

The Relay codebase is **strict TypeScript 5.4+, ESM-only, Node ≥20.10**. Strict means strict — `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` all on. The type system is load-bearing; flow authors get autocomplete and refactor safety from it, not from documentation.

## Hard rules

1. **No `any`.** If the type is genuinely unknown, use `unknown` and narrow before use. `any` defeats the system.
2. **No `as` casts** unless you're narrowing through a discriminator the compiler can't follow. Use type guards.
3. **No `// @ts-ignore` and no `// @ts-expect-error`** in production code. Errors get fixed.
4. **Imports include the `.js` extension** (NodeNext resolution requires it, even for `.ts` source files).
5. **`import type`** for type-only imports. `verbatimModuleSyntax` enforces this.
6. **Re-export from a single `index.ts` per module.** The public surface is what `index.ts` says it is.

## ESM specifics (NodeNext)

```ts
// ✅ Correct — .js extension even though source is .ts
import { Orchestrator } from './orchestrator/orchestrator.js';
import type { Race } from './race/types.js';
import { z } from 'zod';

// ❌ Wrong — no extension
import { Runner } from './runner/runner';

// ❌ Wrong — type imported as value (verbatimModuleSyntax errors)
import { Race } from './race/types.js';

// ✅ Replace __dirname / __filename
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

## Discriminated unions (the workhorse pattern)

Relay's `Runner`, `PromptRunnerOutput`, `InvocationEvent`, and error class hierarchy all use discriminated unions. The pattern:

```ts
type Runner =
  | { kind: 'prompt';   id: string; spec: PromptRunnerSpec   }
  | { kind: 'script';   id: string; spec: ScriptRunnerSpec   }
  | { kind: 'branch';   id: string; spec: BranchRunnerSpec   }
  | { kind: 'parallel'; id: string; spec: ParallelRunnerSpec }
  | { kind: 'terminal'; id: string; spec: TerminalRunnerSpec };

function execute(runner: Runner) {
  switch (runner.kind) {
    case 'prompt':   return executePrompt(runner);    // runner.spec is PromptRunnerSpec
    case 'script':   return executeScript(runner);    // runner.spec is ScriptRunnerSpec
    case 'branch':   return executeBranch(runner);
    case 'parallel': return executeParallel(runner);
    case 'terminal': return executeTerminal(runner);
    default: assertNever(runner);                     // exhaustiveness check
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}
```

The `assertNever` helper turns a missed `case` into a compile error.

## Type narrowing

Prefer the type system's narrowing over `as`:

```ts
// ✅ Type guard
function isPromptRunner(s: Runner): s is Extract<Runner, { kind: 'prompt' }> {
  return s.kind === 'prompt';
}

// ✅ instanceof
if (err instanceof RunnerFailureError) {
  console.log(err.runnerId);   // narrowed
}

// ✅ in operator
if ('schema' in runner.spec.output) {
  // narrowed to the output variant that has schema
}

// ❌ Don't do this
const promptRunner = runner as Extract<Runner, { kind: 'prompt' }>;
```

## Zod inference

Pair every schema with its inferred type — never write the type by hand and the schema separately:

```ts
import { z } from 'zod';

export const InventorySchema = z.object({
  packages: z.array(z.object({
    path: z.string(),
    name: z.string(),
    language: z.enum(['ts', 'py', 'go', 'rust', 'other']),
  })),
});

export type Inventory = z.infer<typeof InventorySchema>;
```

Now `Inventory` and `InventorySchema` can never drift. If you change one, the compiler tells you.

## `noUncheckedIndexedAccess`

Array and record access returns `T | undefined`:

```ts
const runners: Record<string, Runner> = { ... };

// ❌ Won't compile — could be undefined
const r = runners['inventory'];
r.spec;

// ✅ Narrow first
const r = runners['inventory'];
if (r === undefined) throw new Error('missing runner');
r.spec;

// ✅ Or use a guarded accessor
function requireRunner(runners: Record<string, Runner>, id: string): Runner {
  const r = runners[id];
  if (!r) throw new RaceDefinitionError(`unknown runner: ${id}`);
  return r;
}
```

## Branded types for IDs

When you have multiple ID-shaped strings (runId, runnerId, batonId), brand them so they can't be confused:

```ts
export type RunId = string & { readonly __brand: 'RunId' };
export type RunnerId = string & { readonly __brand: 'RunnerId' };

export function asRunId(s: string): RunId { return s as RunId; }
export function asRunnerId(s: string): RunnerId { return s as RunnerId; }
```

Now `function loadRun(id: RunId)` won't accept a `RunnerId` by mistake. (Use sparingly — only when the confusion has bitten.)

## Async patterns

```ts
// ✅ Top-level await is fine in ESM
const config = await loadConfig();

// ✅ Always await — no fire-and-forget in production code
await orchestrator.run(race, input);

// ❌ Promise.then chain when async/await is clearer
fetch(url).then(r => r.json()).then(processData);

// ✅
const r = await fetch(url);
const data = await r.json();
processData(data);

// ✅ Aggregate errors from parallel work
const results = await Promise.allSettled(branches.map(executeBranch));
const failed = results.filter(r => r.status === 'rejected');
if (failed.length) throw new AggregateError(failed.map(f => f.reason));
```

## When the type system is fighting you

The right response is almost never `as` or `any`. It's usually:

1. **Wrong type at the boundary.** Refine the input type so downstream code doesn't need to narrow.
2. **Missing discriminator.** Add a `kind` field to make the union narrowable.
3. **Over-eager narrowing.** Sometimes a function should accept the broader union and return per-variant.
4. **Genuine `unknown`.** Use `unknown` with a Zod schema to safely narrow at the boundary.

## References

- `references/tsconfig-strict.md` — what every `compilerOptions` flag does and why
- `references/esm-patterns.md` — NodeNext gotchas, `import.meta.url`, dynamic imports, `__dirname` replacement
- `references/zod-patterns.md` — Zod schema → type inference, refinement, transforms, parsing at boundaries
