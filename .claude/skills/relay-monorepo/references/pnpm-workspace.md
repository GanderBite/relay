# pnpm Workspace — Reference

## Why pnpm

- Disk-efficient (content-addressable store, hard-linked into `node_modules`).
- Strict by default — packages can't import deps they didn't declare.
- First-class workspace support.
- Lockfile (`pnpm-lock.yaml`) is deterministic and diff-friendly.

## Root files

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
  - 'packages/flows/*'
  - 'examples/*'
```

The two-deep `packages/flows/*` is the catalog flow location. Examples are separate so they don't pollute the catalog space.

### `.npmrc`

```
save-exact=true
strict-peer-dependencies=false
auto-install-peers=true
shamefully-hoist=false
node-linker=isolated
```

- `save-exact`: reproducible installs.
- `strict-peer-dependencies=false`: flow packages declare `@relay/core` as a peer; we don't want install to fail when versions are within range but not strictly equal.
- `auto-install-peers=true`: convenience for users installing single flow packages.
- `shamefully-hoist=false`: keep the strict pnpm graph.
- `node-linker=isolated`: each package gets its own `node_modules`. Slower install, much fewer cross-package surprises.

### Root `package.json`

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
    "lint": "pnpm -r --parallel lint",
    "clean": "pnpm -r --parallel clean"
  },
  "engines": { "node": ">=20.10" },
  "packageManager": "pnpm@9.0.0"
}
```

## Common commands

| Goal | Command |
|---|---|
| Install everything | `pnpm install` |
| Add dep to one package | `pnpm -F @relay/core add zod` |
| Add dev dep to root | `pnpm add -D -w typescript` |
| Run script in one package | `pnpm -F @relay/core build` |
| Run script everywhere | `pnpm -r --parallel build` |
| Run script in package + dependents | `pnpm -F @relay/core... build` |
| Run script in package + dependencies | `pnpm -F ...@relay/cli build` |
| Execute a binary | `pnpm -F @relay/cli exec relay --version` |
| Lockfile-only update | `pnpm install --lockfile-only` |
| Outdated check | `pnpm outdated -r` |

## Workspace dependency syntax

```json
"dependencies": {
  "@relay/core": "workspace:^",      // any version satisfying current major
  "@relay/core": "workspace:~",      // any version satisfying current minor
  "@relay/core": "workspace:*",      // any version (use sparingly)
  "@relay/core": "workspace:0.1.0"   // exact in workspace, rewritten on publish
}
```

`workspace:` prefix is rewritten at publish time to a concrete version range. `^` is the safe default.

## Adding a new package

```bash
mkdir -p packages/<name>/src packages/<name>/tests
cd packages/<name>
# create package.json (copy template), tsconfig.json, tsup.config.ts, vitest.config.ts
cd ../..
pnpm install   # picks up the new package via the workspace yaml
```

The workspace yaml glob (`packages/*`) matches automatically — no manual registration.

## Lockfile policy

- `pnpm-lock.yaml` is committed. Required for reproducible installs.
- Don't hand-edit it. Use `pnpm install --no-frozen-lockfile` if you must rebuild it.
- CI uses `pnpm install --frozen-lockfile` (default in CI environments).

## Catching mismatches early

```bash
pnpm install                    # fails if lockfile is out of date
pnpm -r --parallel typecheck    # catches cross-package API drift
pnpm -r --parallel test         # catches runtime breakage
```

Run all three before committing changes that touch package boundaries.
