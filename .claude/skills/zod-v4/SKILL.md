---
name: zod-v4
description: Zod v4 idioms for the Relay codebase — the v3 → v4 symbol table, the `z.ZodType<T>` pattern that replaces `ZodSchema<T>`, the `z.core.$ZodIssue` type used in `HandoffSchemaError`, the unchanged `instanceof z.ZodType` runtime check, and the v4-only error helpers like `z.treeifyError`. Trigger this skill whenever you write or refactor a `.ts` file that imports from `'zod'` or `'../zod.js'`, or that exposes a Zod type in a public signature (e.g. `FlowSpec.input`, a handoff schema, a prompt `output.schema`). Pair with the `typescript` skill.
---

# Zod v4 for Relay

`packages/core/package.json` pins `zod@4.3.6`. We use v4 idioms — not v3 aliases. The v4 package ships deprecated aliases for `ZodSchema`, `ZodTypeAny`, `ZodIssue`, and `infer as Infer` so old code still compiles, but every one of those names emits a deprecation warning at build time and is explicitly marked `@deprecated` in the installed `.d.ts`. Do not use them.

## The single re-export

All of `@relay/core` funnels Zod through one file:

```ts
// packages/core/src/zod.ts
export { z } from 'zod';
```

Two patterns for importing it:

```ts
// Inside @relay/core — import from the relative re-export
import { z } from '../zod.js';

// Outside @relay/core (future flow packages, examples) — import from the public entry
import { z } from '@relay/core';
```

Never import named type aliases from `'zod'` directly. Reach for them through `z.*`.

## v3 → v4 symbol table

| v3-shaped (deprecated) | v4-canonical | Notes |
|---|---|---|
| `ZodSchema<T>` | `z.ZodType<T>` | 1-arg form is the direct replacement |
| `ZodTypeAny` | `z.ZodType` | no generic = wildcard |
| `ZodIssue` | `z.core.$ZodIssue` | library-author convention |
| `infer as Infer` | `z.infer<typeof X>` | `z.infer` stays canonical in v4 |
| `z` (value) | `z` | unchanged |
| `instanceof z.ZodType` | `instanceof z.ZodType` | `ZodType` is both an interface and a class in v4 |
| `result.error.issues` | `result.error.issues` | shape unchanged: `{ code, path, message, input }` |

If you find yourself typing `ZodSchema`, `ZodTypeAny`, `ZodIssue`, or top-level `Infer`, stop and use the v4 form.

## `z.ZodType` patterns

One-arg, for typed schemas:

```ts
export interface FlowSpec<TInput> {
  input: z.ZodType<TInput>;                // v3: ZodSchema<TInput>
  ...
}
```

No-arg, for "any schema" wildcards:

```ts
export type PromptStepOutput =
  | { handoff: string; schema?: z.ZodType }   // any schema accepted
  | { artifact: string }
  | { handoff: string; artifact: string; schema?: z.ZodType };
```

Two-arg, only when a `z.transform()` makes input and output diverge:

```ts
// input: a string; output: the parsed number
const numericString: z.ZodType<number, string> = z.string().transform(Number);
```

**Gotcha:** `z.ZodType<Output, Input>` has weaker generic inference than v3's `ZodSchema<T>`. Almost always you want the 1-arg form. Don't chase inference with the 2-arg form.

## Schema → type inference

Canonical, unchanged in v4:

```ts
import { z } from '../zod.js';

export const InventorySchema = z.object({
  packages: z.array(z.object({
    path: z.string(),
    name: z.string(),
  })),
});

export type Inventory = z.infer<typeof InventorySchema>;
```

`z.input<typeof X>` and `z.output<typeof X>` are available for the rare case where a transform makes them differ. Use `z.infer` (= `z.output`) by default.

## Issue handling — the `HandoffSchemaError` contract

`safeParse` returns `{ success: false; error: z.ZodError }` on failure. `error.issues` is a `z.core.$ZodIssue[]`. Each issue is `{ code, path, message, input? }`.

```ts
import type { z } from '../zod.js';
import { HandoffSchemaError } from '../errors.js';

function parseHandoff<T>(
  schema: z.ZodType<T>,
  handoffId: string,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HandoffSchemaError(
      `handoff "${handoffId}" failed schema validation`,
      handoffId,
      result.error.issues,            // z.core.$ZodIssue[]
    );
  }
  return result.data;
}
```

**Use only `issue.code`, `issue.message`, and `issue.path`** when serializing. These three fields are stable across v4 point releases.

**Do not use the v3 helpers that v4 removed**: `.format()`, `.flatten()`, `.formErrors`, `.addIssue()` are all gone. For pretty-printing a `ZodError`, use `z.treeifyError(error)` or `z.prettifyError(error)` — both live on the `z` namespace.

## Runtime narrowing

`instanceof z.ZodType` is the right check for "is this a Zod schema?" — v4 keeps `z.ZodType` as a concrete class constructor exactly so this works:

```ts
if (!(spec.input instanceof z.ZodType)) {
  throw new FlowDefinitionError('flow "input" must be a Zod schema');
}
```

Do not invent alternatives (`._zod` property checks, duck-typing `.parse`) unless you genuinely need to interop with a mixed-version dependency tree — inside `@relay/core` we don't.

## What changed from v3 that matters for small library code

- `ZodSchema`, `ZodTypeAny`, `Infer` are deprecated aliases. They still compile. They still misuse the reader's attention. Don't write them.
- `ZodIssue` at the top level is deprecated in favor of `z.core.$ZodIssue`.
- `.format()` / `.flatten()` / `.formErrors` / `.addIssue()` are gone. Use `z.treeifyError` / mutate `error.issues[]` directly if you must.
- Performance: ~14–15× faster string and array validation; 100× fewer type instantiations. No action needed — just a free win.
- Library-author guidance: https://zod.dev/library-authors says to import `$ZodIssue` via `z.core.$ZodIssue` (not via `zod/v4/core`). We follow that — importing from the subpath couples to internal layout.

## Checklist before you open a PR that touches a `.ts` under `packages/core`

- Every import from `'zod'` or `'../zod.js'` brings in `z` (value) or nothing else.
- Every appearance of `ZodSchema`, `ZodTypeAny`, `ZodIssue`, `Infer` is replaced with the v4 form.
- `z.ZodType<T>` (1-arg) is the default; 2-arg only when a transform makes input/output diverge.
- `instanceof z.ZodType` is used unchanged for runtime narrowing.
- `issue.code`, `issue.message`, `issue.path` are the only `$ZodIssue` fields touched during serialization.

## References

- https://zod.dev/v4 — the v4 introduction
- https://zod.dev/v4/changelog — the full migration guide
- https://zod.dev/library-authors — why `@relay/core` should import types via `z.core.*` rather than the `zod/v4/core` subpath
- `../typescript/SKILL.md` — pair with this skill for strict-mode + Zod inference patterns
