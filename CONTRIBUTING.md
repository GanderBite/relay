# Contributing to Relay

---

## Prerequisites

- Node >= 20.10
- pnpm >= 10

---

## Local setup

```bash
git clone https://github.com/ganderbite/relay.git
cd relay
pnpm install
pnpm -r build
pnpm -r test
```

---

## Running a single package

```bash
# Run tests for one package
pnpm -F @relay/core test

# Typecheck one package without running tests
pnpm -F @relay/cli typecheck
```

---

## PR checklist

Before opening a pull request, verify each item:

- [ ] Typecheck passes across the workspace: `pnpm -r typecheck`
- [ ] Tests pass across the workspace: `pnpm -r test`
- [ ] Every new public API symbol has a JSDoc comment
- [ ] User-facing strings follow the voice rules: banned words absent, no trailing exclamation marks, no emojis
- [ ] New error paths name the next command — no dead-ends in error output

---

## Coding conventions

Full rules live in [`docs/naming-conventions.md`](docs/naming-conventions.md). The short version:

**TypeScript** — strict mode throughout. ESM only (`"type": "module"`). Node >= 20.10. TypeScript 5.4+. No `any`, no `as` casts, no `// @ts-ignore`. Import extensions must be explicit (`.js` for compiled output).

**Error handling** — all fallible functions return `Result<T, E>` via [neverthrow](https://github.com/supermacro/neverthrow). Throwing is forbidden across `@relay/core`. Callers pattern-match on `result.isOk()` / `result.isErr()`.

**File writes** — any file another process might read (`state.json`, handoffs, metrics) must use the `atomicWriteJson` helper from `@relay/core`. No direct `fs.writeFile` on shared state.

**Naming** — the canonical nouns are Flow, Step, and Handoff. See `docs/naming-conventions.md` for the full words-to-avoid list.
