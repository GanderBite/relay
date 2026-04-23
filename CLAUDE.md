# Relay — Claude Code Working Notes

Relay is a TypeScript monorepo (pnpm workspaces) that ships a CLI + library for running multi-step Claude Code workflows that resume after crashes, never bill the API by surprise, and produce the same artifact every time.

> **Working name in older spec:** "PipelineKit." The product spec renames everything to "Relay" — package names are `@relay/core`, `@relay/cli`, `@relay/generator`. When the tech spec says `@pipelinekit/*`, mentally substitute `@relay/*`.

## Where to read first

- `_specs/pipelinekit-tech_spec.md` — what gets built and how (architecture, types, runtime).
- `_specs/relay-product_spec.md` — what the user sees (voice, mark, CLI output, copy). **The product spec wins on every visible string.**
- `_work/sprint-<N>.json` — the sprint backlog. One sprint per session. Each sprint has waves of parallel tasks.

## Repo layout (target — built up over the sprints)

```
relay/
├── packages/
│   ├── core/        # @relay/core — library (defineFlow, Step, Provider, ...)
│   ├── cli/         # @relay/cli — the `relay` binary
│   ├── generator/   # @relay/generator — Claude Code skill that scaffolds new flows
│   └── flows/       # reference flow packages (codebase-discovery)
├── examples/        # hello-world + hello-world-mocked
├── catalog/         # static catalog site (M4)
└── docs/            # copy-kit, naming-conventions, etc.
```

## How sessions run

One sprint per session. The user invokes the `sprint-workflow` skill (or just says "work on sprint N"). Claude reads `_work/sprint-N.json`, then for each wave dispatches the wave's tasks in parallel to the agent that fits each task. Tasks within a wave have no inter-dependencies; tasks across waves do.

## The eight agents (`.claude/agents/`)

| Agent | Use it for |
|---|---|
| `task-implementer` | Default workhorse — low/medium-risk implementation tasks |
| `systems-engineer` | High-risk core: Runner, ClaudeProvider, DAG/cycles, retry, abort |
| `cli-ux-engineer` | Any CLI command — output must match product spec verbatim |
| `flow-author` | Prompt files + flow.ts for examples and reference flows |
| `test-engineer` | Vitest tests using MockProvider |
| `code-reviewer` | Post-implementation review against spec sections |
| `doc-writer` | README hero, copy-kit, glossary, naming conventions |
| `catalog-builder` | Static catalog site, registry generator, flow-package linter |

## The skills (`.claude/skills/`)

| Skill | Read it when |
|---|---|
| `sprint-workflow` | Dispatching a sprint's tasks across agents |
| `relay-brand-grammar` | Touching any user-visible string |
| `relay-monorepo` | Configuring pnpm / tsconfig / tsup / vitest at the workspace level |
| `flow-package-format` | Building or validating a flow package (§7) |
| `billing-safety` | Anything that touches `ANTHROPIC_API_KEY`, auth, env |
| `typescript` | Writing or refactoring `.ts` — strict mode, ESM, discriminated unions, Zod inference |
| `javascript` | Editing the small JS surface — bin shims, catalog browser JS, GitHub Actions |
| `vitest` | Writing or maintaining tests — mocking, snapshots, async, MockProvider |
| `claude-cli-provider` | Building or wiring `ClaudeCliProvider` — subprocess lifecycle, stream-json, env allowlist |
| `relay-settings` | Three-tier provider selection, `relay init`, `NoProviderConfiguredError` |

## Hooks (`.claude/settings.json`)

The harness runs four hook events to keep the loop tight:

- **SessionStart** — prints the sprint backlog and recent commits.
- **PreToolUse on `Write|Edit|MultiEdit`** — blocks edits to `_specs/` and `_work/sprint-*.json`. Specs are frozen; raise spec issues with the user instead of editing.
- **PreToolUse on `Bash`** — blocks destructive patterns (`npm publish`, `git push --force`, `git reset --hard`, `rm -rf` against `_specs/`, `_work/`, `.git/`, root, or home).
- **PostToolUse on `Bash`** — after `git commit`, echoes the new SHA and subject line.
- **Stop** — lists changed packages and prints the exact `pnpm -F <pkg> typecheck` command for each.

## Hard rules (do not violate)

1. **No emojis in any code, output, or doc.** Use the Unicode symbol vocabulary only (`✓ ✕ ⚠ ⠋ ○ · ●─▶`). The mark `●─▶●─▶●─▶●` is the brand.
2. **The word "simply" is banned in user-facing copy.** Same with trailing exclamation marks.
3. **Subscription billing is the default.** `ANTHROPIC_API_KEY` must trigger `ClaudeAuthError` unless explicitly opted in. See `billing-safety` skill. Each provider enforces its own auth contract; see the `claude-cli-provider` and `billing-safety` skills for the auth contract.
4. **ESM only, Node ≥20.10, TypeScript 5.4+.** No CJS dual-publish.
5. **Atomic writes for any file other processes might read** (state.json, batons/*, metrics.json, live/*).
6. **Each task ends with one atomic commit** referencing the task ID.

## Spec section references

Tasks reference spec sections like `§4.6.8` (tech spec) and `§6.5` (product spec). When a task says "MUST match product spec §6.3 verbatim," it means byte-for-byte — copy from the spec, don't paraphrase.
