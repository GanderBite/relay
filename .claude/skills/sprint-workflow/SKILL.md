---
name: sprint-workflow
description: How to execute a Relay sprint — read the sprint JSON in `_work/sprint-<N>.json`, dispatch each wave's tasks in parallel to the right agents, validate after each wave, and commit atomically per task. Trigger when the user says "work on sprint N", "execute sprint", "start the sprint", "next wave", or any phrase that refers to running tasks from a sprint backlog. This skill encodes the wave protocol so a session can fan out work without losing track of dependencies.
---

# Sprint Workflow

Relay ships in 12 sprints. One sprint per session. Each sprint is a JSON file at `_work/sprint-<N>.json` with this shape:

```jsonc
{
  "sprint": <N>,
  "name": "<sprint title>",
  "description": "<sprint goal>",
  "spec_sections": ["§4.6", "§4.9"],
  "product_spec_sections": ["§6.3"],   // some sprints only
  "waves": [
    [ { "id": "task_X", "name": "...", "description": "...",
        "target_files": [...], "depends_on": [...],
        "module": "...", "tags": [...], "risk": "low|medium|high" } ],
    [ { ... }, { ... } ],   // wave 2
    ...
  ]
}
```

## The protocol

### Step 1 — Read the whole sprint JSON
Don't dispatch task by task without seeing the whole sprint. Note the wave count, dependency edges, and risk tags up front. **Reference: `references/task-schema.md`** for the full task object shape.

### Step 2 — Run wave 1 in parallel
Tasks within a wave have no inter-dependencies — they run concurrently. For each task in the wave, pick an agent (table below) and dispatch via the Agent tool. **Send all the wave's Agent tool calls in one message** so they truly parallelize. **Reference: `references/parallel-execution.md`** for the dispatch pattern.

### Step 3 — Validate the wave
After all wave-1 agents return, run `pnpm -F <pkg> typecheck` (or `tsc --noEmit`) for every package touched. If anything fails, dispatch a follow-up to the agent that owned the failing task — don't fix it yourself.

### Step 4 — Move to wave 2
Wave 2 tasks `depends_on` wave-1 tasks. Now those outputs exist on disk, so wave 2 can read them. Repeat.

### Step 5 — Final wave validation
After the last wave: run all package typechecks again, run any tests that exist, then dispatch the `code-reviewer` agent across the high-risk files for an independent read.

### Step 6 — Hand back to the user
Print a sprint summary: tasks done, files touched, anything flagged by the reviewer, anything blocked.

## Agent picker

| Task signal | Agent |
|---|---|
| Tag includes `scaffolding`, `foundation`, `util`, `templates`; risk: low | `task-implementer` |
| `risk: high` AND module starts with `core.runner`, `core.providers.claude`, `core.flow` | `systems-engineer` |
| Module starts with `cli.` (commands, banner, progress, visual, help) | `cli-ux-engineer` |
| Path includes `prompts/`, `flow.ts` in `examples/` or `packages/flows/`, or `packages/generator/templates/` | `flow-author` |
| Path includes `tests/`, or task name starts with "Test" | `test-engineer` |
| Path starts with `docs/` or is the root `README.md` | `doc-writer` |
| Path starts with `catalog/` or is `packages/cli/src/lint.ts` / `registry.ts` | `catalog-builder` |
| Post-wave review pass (no specific task) | `code-reviewer` |

When two signals match, the more specific one wins. CLI commands always go to `cli-ux-engineer` even if marked `risk: low`.

## Briefing each agent

When you dispatch an agent, your prompt should include:

1. **The full task object** (paste the JSON block).
2. **The current working directory** (`/Users/michalgasiorek/Projekty/ganderbite/relay/`).
3. **Any prior task outputs the agent needs** — list the files from `depends_on` tasks the agent should read first.
4. **Any spec excerpts longer than a few paragraphs** — the agent has the full specs available but pre-quoting saves time.
5. **The expected handoff back to you** — usually "report which files you wrote, any deviations, and whether typecheck passes."

See `references/parallel-execution.md` for an example briefing block.

## Wave-1 special case for sprint 0

Sprint 0 has only wave 1 (one task — the monorepo root). After it lands, the package skeletons in wave 2 of sprint 0 become unblockable in parallel. Ordinary protocol from there.

## When a task is ambiguous

Forward the ambiguity to the user before dispatching. The agents will pick the strict reading and ship — if the strict reading is wrong, you've wasted a wave. A 30-second clarification beats a re-roll.

## Commits

Each agent commits its own task atomically. Don't batch commits across tasks. The commit message format is in the agent definitions; the orchestrator does not need to commit anything itself.

## Sprint summary template

After all waves complete, print:

```
sprint <N> · <name>
─────────────────
waves run        : <n>
tasks completed  : <n>/<total>
files touched    : <count>
typecheck        : <pass|fail per package>
reviewer flags   : <count BLOCK, count FLAG>
blocked          : <task IDs the user needs to unblock, if any>

next: sprint <N+1> — <name>
```
