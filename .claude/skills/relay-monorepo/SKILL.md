---
name: relay-monorepo
description: Conventions for the Relay pnpm-workspace monorepo — root config, per-package package.json shape, tsconfig setup, tsup bundling config, vitest test setup, ESM-only Node 20.10 + TypeScript 5.4 stack. Trigger this skill when scaffolding a new package, configuring `tsup.config.ts` or `tsconfig.json`, wiring `vitest.config.ts`, adding workspace dependencies (`workspace:^`), or troubleshooting the build pipeline. Used by the foundational sprint-0 tasks and any later task that touches build infrastructure.
---

# Relay Monorepo Conventions

The repo is a pnpm workspace. Four packages plus `examples/` plus `packages/flows/`. ESM-only. Node ≥20.10. TypeScript 5.4+.

## Root layout

```
relay/
├── package.json            # workspace root, private
├── pnpm-workspace.yaml     # lists workspace dirs
├── tsconfig.base.json      # shared TS config; per-package extends
├── .npmrc                  # pnpm config (save-exact, strict-peer-dependencies)
├── .gitignore
└── packages/ examples/ catalog/ docs/
```

## pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
  - 'packages/flows/*'
  - 'examples/*'
```

Add `catalog/` only if it ships as a workspace package (it doesn't in v1 — it's a static folder).

## Root package.json

```json
{
  "name": "relay",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r --parallel build",
    "typecheck": "pnpm -r --parallel typecheck",
    "test": "pnpm -r --parallel test",
    "lint": "pnpm -r --parallel lint"
  },
  "engines": {
    "node": ">=20.10"
  },
  "packageManager": "pnpm@9.0.0"
}
```

Pin `packageManager` so `corepack` activates the right pnpm version automatically.

## tsconfig.base.json

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
    "lib": ["ES2022"],
    "types": ["node"]
  }
}
```

`noEmit: true` at the base — packages that emit (via `tsc` or `tsup`) override per their own tsconfig.

## .npmrc

```
save-exact=true
strict-peer-dependencies=false
auto-install-peers=true
```

`strict-peer-dependencies=false` because flow packages declare `@relay/core` as a peer, and we don't want pnpm to refuse install when a user's node_modules predates the publish.

## Per-package package.json (library)

```json
{
  "name": "@relay/core",
  "version": "0.1.0",
  "type": "module",
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
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "zod": "^3.23.0",
    "zod-to-json-schema": "^3.22.0"
  },
  "peerDependencies": {
    "@anthropic-ai/claude-agent-sdk": "*"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.0.0"
  }
}
```

The `exports` map gates the public surface. `./testing` is a subpath export so flow authors can `import { MockProvider } from '@relay/core/testing'` without polluting the main entry.

## Per-package tsconfig.json

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

A separate `tsconfig.test.json` extends this with `"include": ["tests/**/*"]` and `"types": ["node", "vitest/globals"]` for the test runner.

## tsup.config.ts (per package)

```ts
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
});
```

ESM only. No CJS dual-publish (per tech spec §3.2). `dts: true` emits `.d.ts` alongside `.js` so consumers get types without a separate `tsc` step.

## vitest.config.ts (per package)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/testing/**'],
    },
    globals: true,
  },
});
```

Coverage target for `@relay/core` is 80% line coverage per M1 acceptance.

## Workspace dependency syntax

Use `workspace:^` for in-repo deps:

```json
"dependencies": {
  "@relay/core": "workspace:^"
}
```

pnpm rewrites this to a real version range at publish time.

## CLI binary package

```json
{
  "name": "@relay/cli",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/cli.js",
  "bin": {
    "relay": "./bin/relay.js"
  },
  "files": ["dist", "bin"],
  "dependencies": {
    "@relay/core": "workspace:^",
    "commander": "^12.0.0",
    "chalk": "^5.3.0"
  }
}
```

`bin/relay.js` is a tiny shebang shim:

```js
#!/usr/bin/env node
import('../dist/cli.js').then(m => m.main(process.argv));
```

## Common commands

```bash
pnpm install                     # install all workspace deps
pnpm -F @relay/core build        # build one package
pnpm -F @relay/core typecheck    # typecheck one package
pnpm -F @relay/core test         # test one package
pnpm -r --parallel build         # build everything
pnpm -F @relay/cli exec relay --version  # run the binary from a package
```

## Anti-patterns

- **No CJS.** Don't dual-publish. Don't use `require()`. Don't add `"main"` pointing at a CJS file.
- **No `__dirname`.** Use `import.meta.url` + `fileURLToPath`.
- **Don't pin `peerDependencies` strictly.** Use `^1.0.0` or `*` (for SDK), not `1.0.0`.
- **Don't put runtime code in `devDependencies`.** TypeScript and `@types/*` go to dev; everything imported at runtime goes to prod or peer.
- **Don't add `"main"` AND `"module"` AND `"exports"`.** `exports` wins; the others are legacy. Keep `main` and `types` for older resolvers but make them point to the same files `exports["."]` does.
