---
name: typescript
description: TypeScript 5.4+ patterns for the Relay codebase — strict mode discipline, ESM with NodeNext resolution, discriminated unions (used heavily in Step types and InvocationEvent), Zod schema inference, type narrowing, branded types, the ban on `any` and `as` casts, and the import-extension rules ESM enforces. Trigger this skill when writing or refactoring any `.ts` file, when designing types for a new module, when the type system is fighting you, or when an agent is tempted to reach for `any` or `// @ts-ignore`.
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
import { Runner } from './runner/runner.js';
import type { Flow } from './flow/types.js';
import { z } from 'zod';

// ❌ Wrong — no extension
import { Runner } from './runner/runner';

// ❌ Wrong — type imported as value (verbatimModuleSyntax errors)
import { Flow } from './flow/types.js';

// ✅ Replace __dirname / __filename
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

## Discriminated unions (the workhorse pattern)

Relay's `Step`, `PromptStepOutput`, `InvocationEvent`, and error class hierarchy all use discriminated unions. The pattern:

```ts
type Step =
  | { kind: 'prompt';   id: string; spec: PromptStepSpec   }
  | { kind: 'script';   id: string; spec: ScriptStepSpec   }
  | { kind: 'branch';   id: string; spec: BranchStepSpec   }
  | { kind: 'parallel'; id: string; spec: ParallelStepSpec }
  | { kind: 'terminal'; id: string; spec: TerminalStepSpec };

function execute(step: Step) {
  switch (step.kind) {
    case 'prompt':   return executePrompt(step);    // step.spec is PromptStepSpec
    case 'script':   return executeScript(step);    // step.spec is ScriptStepSpec
    case 'branch':   return executeBranch(step);
    case 'parallel': return executeParallel(step);
    case 'terminal': return executeTerminal(step);
    default: assertNever(step);                     // exhaustiveness check
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
function isPromptStep(s: Step): s is Extract<Step, { kind: 'prompt' }> {
  return s.kind === 'prompt';
}

// ✅ instanceof
if (err instanceof StepFailureError) {
  console.log(err.stepId);   // narrowed
}

// ✅ in operator
if ('schema' in step.spec.output) {
  // narrowed to the output variant that has schema
}

// ❌ Don't do this
const promptStep = step as Extract<Step, { kind: 'prompt' }>;
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
const steps: Record<string, Step> = { ... };

// ❌ Won't compile — could be undefined
const s = steps['inventory'];
s.spec;

// ✅ Narrow first
const s = steps['inventory'];
if (s === undefined) throw new Error('missing step');
s.spec;

// ✅ Or use a guarded accessor
function requireStep(steps: Record<string, Step>, id: string): Step {
  const s = steps[id];
  if (!s) throw new FlowDefinitionError(`unknown step: ${id}`);
  return s;
}
```

## Branded types for IDs

When you have multiple ID-shaped strings (runId, stepId, handoffId), brand them so they can't be confused:

```ts
export type RunId = string & { readonly __brand: 'RunId' };
export type StepId = string & { readonly __brand: 'StepId' };

export function asRunId(s: string): RunId { return s as RunId; }
export function asStepId(s: string): StepId { return s as StepId; }
```

Now `function loadRun(id: RunId)` won't accept a `StepId` by mistake. (Use sparingly — only when the confusion has bitten.)

## Async patterns

```ts
// ✅ Top-level await is fine in ESM
const config = await loadConfig();

// ✅ Always await — no fire-and-forget in production code
await runner.run(flow, input);

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
