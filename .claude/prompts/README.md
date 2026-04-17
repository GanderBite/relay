# Relay Sprint Prompts

Copy-pasteable prompt templates for running Relay sprints in Claude Code. Every template is tuned to invoke the right **skills** and **agents** so Claude does not short-circuit the orchestration layer.

## Which template do I use?

| You want to... | Template | Placeholders to fill |
|---|---|---|
| Run a whole sprint end-to-end (most common) | `sprint-execute.md` | `SPRINT_NUMBER` |
| Continue a sprint that stopped mid-way | `sprint-resume.md` | `SPRINT_NUMBER`, `START_WAVE` |
| Re-run one specific task (e.g., after a spec tweak) | `sprint-single-task.md` | `SPRINT_NUMBER`, `TASK_ID` |
| Audit a finished sprint (typechecks + reviewer pass only) | `sprint-verify.md` | `SPRINT_NUMBER` |

## How to use a template

1. Open the template file.
2. Copy the whole contents.
3. Paste into a fresh Claude Code session opened at the Relay repo root.
4. Fill in the placeholders in the `<inputs>` block at the top.
5. Send.

## Agent vocabulary

Every template dispatches via the `Agent` tool and references agents in prose as `@<name> (agent)`:

| Agent | Picks tasks that... |
|---|---|
| `@task-implementer (agent)` | are the default low/medium-risk workhorse work |
| `@systems-engineer (agent)` | are `risk: high` in `core.runner` / `core.providers.claude` / `core.flow` |
| `@cli-ux-engineer (agent)` | are in `cli.*` modules — output must match product spec verbatim |
| `@flow-author (agent)` | touch `prompts/`, `flow.ts`, or generator templates |
| `@test-engineer (agent)` | write tests under `tests/` |
| `@doc-writer (agent)` | touch `docs/`, root `README.md`, or per-flow READMEs |
| `@catalog-builder (agent)` | touch `catalog/`, `lint.ts`, `registry.ts`, or the deploy workflow |
| `@code-reviewer (agent)` | do a post-wave review pass (returns findings, does not edit code) |

## Skill vocabulary

Templates explicitly name skills so Claude triggers them reliably:

| Skill | Triggers on... |
|---|---|
| `sprint-workflow` | any sprint dispatch — the wave protocol lives here |
| `relay-brand-grammar` | any user-visible string (CLI output, README, error message) |
| `billing-safety` | `ANTHROPIC_API_KEY`, auth, env allowlist, doctor command |
| `flow-package-format` | flow packages in `examples/`, `packages/flows/`, or generator templates |
| `claude-agent-sdk` | anything wiring `@anthropic-ai/claude-agent-sdk` |
| `typescript` | writing or refactoring any `.ts` file |
| `vitest` | writing or maintaining any Vitest test |
| `javascript` | editing bin shims, catalog browser JS, GitHub Actions |
| `relay-monorepo` | scaffolding packages or touching workspace build config |

## Why the templates are structured the way they are

Three mechanisms reduce the chance Claude skips an agent:

1. The `<job>` sentence names the **Agent tool** by name.
2. The `<agents>` block lists every candidate agent with `@<name> (agent)` + a one-line picker rule.
3. The `<do_not>` block explicitly forbids writing code directly — Claude must re-dispatch on failure rather than "fix it".

Skills get the same treatment in `<skills_to_use>`: each skill is named explicitly with its trigger condition so the phrasing inside the prompt matches the skill's own trigger vocabulary.
