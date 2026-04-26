# tsconfig — Strict Mode Options Explained

The Relay base tsconfig (`tsconfig.base.json`) enables a specific strict subset. This document explains why each flag is on.

## The base config

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "noEmit": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "lib": ["ES2022"],
    "types": ["node"]
  }
}
```

## Flag-by-flag

### `target: "ES2022"`
Ships modern syntax (top-level await, class fields, `at()`, structuredClone, error cause). Node 20.10+ supports all of it natively.

### `module: "NodeNext"` + `moduleResolution: "NodeNext"`
True ESM resolution that matches what Node actually does. Requires `.js` extensions in import paths, even from `.ts` source files. The cost is you type more characters; the win is your code runs in Node identically to how the compiler resolved it.

### `esModuleInterop: true`
Lets you `import x from 'mod'` for CJS modules that have `module.exports = ...`. Should rarely matter in this codebase since everything is ESM.

### `skipLibCheck: true`
Don't type-check `.d.ts` files in `node_modules`. Speeds up builds. Trusts that published packages have valid types.

### `strict: true`
Bundles up: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`. The whole strict regime.

### `declaration: true`
Emits `.d.ts` files. Required for library packages — consumers need types.

### `sourceMap: true`
Emits `.js.map` files. Stack traces in errors point at TypeScript source.

### `noEmit: true`
The base says don't emit; per-package configs override this when they want output (`tsup` does the actual emit).

### `isolatedModules: true`
Each file must be independently compilable. Catches edge cases where TypeScript transpiles differently from `swc`/`esbuild`/`tsup`. Required when `tsup` is the bundler.

### `useDefineForClassFields: true`
Uses ES standard semantics for class field initialization (`[[Define]]` not `[[Set]]`). Matches modern JS engines. Required by `target: ES2022`.

### `verbatimModuleSyntax: true`
Type-only imports MUST use `import type { ... } from '...'` (not `import { type X } from '...'`). Type-only exports must use `export type`. The compiler does not "guess" what's a type vs a value at emit time. Catches edge cases where a type import accidentally pulls in a runtime side-effect.

### `noUncheckedIndexedAccess: true`
`array[i]` and `record[key]` return `T | undefined`. You must narrow before use. This catches a real class of bugs (off-by-one, missing key, key-from-untrusted-input) at compile time.

### `noImplicitOverride: true`
Subclasses must use `override` keyword when overriding a parent method. Catches the case where a parent rename leaves the subclass method silently un-overriding.

### `noFallthroughCasesInSwitch: true`
A `case` body must end with `break`, `return`, `throw`, or fall-through is a compile error. Pairs perfectly with the `assertNever(x)` exhaustiveness pattern.

## Per-package overrides

Library packages that emit (`@ganderbite/relay-core`, `@ganderbite/relay`, etc.):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

Test config (separate file, `tsconfig.test.json`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

The split keeps test types out of the published `.d.ts`.

## What you should never turn off

- `strict: true` — keeping any subset off is asking for the bug it would have caught.
- `verbatimModuleSyntax: true` — disabling it makes ESM ↔ CJS interop unpredictable.
- `noUncheckedIndexedAccess: true` — disabling it brings back the entire class of "missing key" bugs.
- `isolatedModules: true` — disabling it lets your code work under `tsc` but break under `tsup`.

## What you might consider turning on later

- `exactOptionalPropertyTypes` — distinguishes `{ x?: T }` (may be omitted) from `{ x?: T | undefined }` (may be omitted OR explicitly undefined). Useful for strict API design; sometimes annoying with libraries that haven't adopted it.
- `noPropertyAccessFromIndexSignature` — forces `record["key"]` over `record.key` when key isn't typed. Catches bugs but verbose.

Don't turn these on without a specific reason — they have real cost.
