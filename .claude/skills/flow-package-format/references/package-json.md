# package.json — Complete Schema

## Annotated example

```json
{
  "name": "@ganderbite/relay-codebase-discovery",
  "version": "0.1.0",
  "description": "Produces an HTML codebase report for PMs and devs.",
  "type": "module",
  "main": "./dist/flow.js",
  "types": "./dist/flow.d.ts",
  "files": ["dist", "prompts", "schemas", "templates", "examples", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "relay test .",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "engines": {
    "node": ">=20.10"
  },
  "keywords": ["relay", "claude", "codebase", "discovery"],
  "repository": {
    "type": "git",
    "url": "https://github.com/ganderbite/relay-flows"
  },
  "license": "MIT",
  "relay": {
    "displayName": "Codebase Discovery",
    "tags": ["discovery", "documentation"],
    "estimatedCostUsd": { "min": 0.20, "max": 0.80 },
    "estimatedDurationMin": { "min": 5, "max": 20 },
    "audience": ["pm", "dev"]
  }
}
```

## Field-by-field

### Required

| Field | Required by | Notes |
|---|---|---|
| `name` | npm + linter | Catalog flows: `@ganderbite/relay-<name>`. Local flows: any. Examples can be private (no scope, `private: true`). |
| `version` | npm + linter | Strict semver. See §7.5 bump rules. |
| `type` | linter | Must be `"module"`. CJS not supported. |
| `main` | linter | `./dist/flow.js` — what `relay run` imports. |
| `peerDependencies` | runtime | Must include `@ganderbite/relay-core`. Use a major-version range (`^1.0.0`). |
| `relay` | linter + CLI | The metadata block below. |

### `relay` block

| Sub-field | Required | Type | Notes |
|---|---|---|---|
| `displayName` | yes | string | Human-readable name for `relay list` and the catalog site. |
| `tags` | yes | string[] | Free-form tags for `relay search`. |
| `estimatedCostUsd` | yes | `{ min: number; max: number }` | Range for the pre-run banner's `est` line. |
| `estimatedDurationMin` | yes | `{ min: number; max: number }` | Range in minutes. |
| `audience` | yes | string[] | One or more of: `pm`, `dev`, `ops`, `qa`, `design`, `legal`, `other`. |
| `repoUrl` | no | string | Link to source. Surfaced on the catalog page. |
| `license` | no | string | SPDX identifier. Catalog flows default to MIT (per product spec §18.4). |

### Optional but recommended

| Field | Why |
|---|---|
| `description` | npm registry + catalog short description |
| `keywords` | npm search |
| `repository` | npm registry + catalog "view source" link |
| `license` | npm + catalog tier badge |
| `engines.node` | npm install warning if user is on old node |

### Anti-patterns

- **Don't put `dependencies` on `@ganderbite/relay-core`** — it's a peer dep, the user's project owns the version. The flow shouldn't pin an incompatible core.
- **Don't include `tsconfig.json` in `files`** — it's a build artifact, not a runtime artifact.
- **Don't use a plain `name` for catalog flows** — the CLI resolves bare `<name>` to `@ganderbite/relay-<name>`. If you publish under a different scope, document it in the README's install section.
- **Don't ship `flow.ts` source** — only `dist/`. Catalog users get the compiled artifact.

## Examples (private, in this monorepo)

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/flow.js",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@ganderbite/relay-core": "workspace:^"
  }
}
```

For local examples, use `workspace:^` to bind to the in-repo version of `@ganderbite/relay-core`. The `relay` metadata block is optional for private examples (the CLI's banner falls back to defaults).
