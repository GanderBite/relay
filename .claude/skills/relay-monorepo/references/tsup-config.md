# tsup Build Config — Per Package

We bundle each package with `tsup` (esbuild under the hood) instead of running raw `tsc` for emit. tsup is faster, generates `.d.ts` in one pass, and handles subpath exports cleanly.

## Canonical config (library — `@ganderbite/relay-core`)

```ts
// packages/core/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
  outDir: 'dist',
});
```

Key choices:

- `format: ['esm']` only. No CJS dual-publish (tech spec §3.2).
- `dts: true` — emits `.d.ts` next to each `.js`. No separate `tsc` invocation needed.
- `splitting: false` — keep one output file per entry. Cleaner subpath exports.
- `treeshake: true` — removes unused imports. Helps the published bundle stay lean.
- `target: 'node20'` — ES2022 features without polyfills.

## CLI package config

```ts
// packages/cli/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  shims: false,
  banner: { js: '#!/usr/bin/env node' },   // optional — only if main IS the bin
});
```

For the CLI, the `bin/relay.js` shim is the executable; `dist/cli.js` is just an importable entry. Don't add a banner to `dist/cli.js`.

## Generator package config

```ts
// packages/generator/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/install.ts', 'src/scaffold.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
});
```

The generator's templates and SKILL.md are static — they ship as files, not JS. Only the install + scaffold scripts get bundled.

## Per-package package.json `exports` to match tsup output

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing/index.d.ts",
      "import": "./dist/testing/index.js"
    }
  }
}
```

The subpath (`./testing`) maps to the second tsup entry. If you add a third entry, add a corresponding `exports` key.

## Build commands

```bash
pnpm -F @ganderbite/relay-core build         # one-shot build
pnpm -F @ganderbite/relay-core build --watch # watch mode (dev)
```

Watch mode is fast — esbuild rebuilds in milliseconds.

## Common gotchas

- **`@ganderbite/relay-core` is a peer dep of flow packages**, but during local dev you want the workspace version. `workspace:^` handles this — pnpm symlinks the workspace package and tsup resolves it normally.
- **dts generation can fail on circular type imports.** If you hit this, usually means you re-exported from a module that imports back. Break the cycle by extracting types to a dedicated `types.ts`.
- **tsup doesn't typecheck.** Run `pnpm -F <pkg> typecheck` separately for `tsc --noEmit`. The `build` script doesn't catch type errors — only the `typecheck` script does.
- **Don't run tsup and tsc in the same script.** Pick one for emit. We use tsup.

## Why not `tsc --build`?

- `tsc` is slower (single-threaded, full type analysis on every change).
- `tsc` doesn't emit `.d.ts` cleanly for ESM-only packages without extra config.
- `tsc` doesn't tree-shake.

The trade: `tsup` doesn't enforce types at build time. Add `pnpm typecheck` to your loop.
