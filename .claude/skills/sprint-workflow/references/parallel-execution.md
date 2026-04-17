# Parallel Execution Pattern

How to actually fan out a wave's tasks across agents in one message.

## The dispatch message

When a wave has N tasks, send **one message** containing N `Agent` tool calls. Anthropic's runtime executes them concurrently. If you send them across multiple messages, they run sequentially — a wasted opportunity.

## Per-task briefing template

Each Agent call's `prompt` field should contain this block (filled in):

```
You are implementing task_<ID> from _work/sprint-<N>.json.

Working directory: /Users/michalgasiorek/Projekty/ganderbite/relay/

The task object:

<paste the full JSON block from waves[<wave>][<idx>]>

Spec references in the task description:
- §<X.Y> — _specs/pipelinekit-tech_spec.md
- (product spec §<A.B>) — _specs/relay-product_spec.md  ← only if cited

Files produced by depends_on tasks you should read first:
- <task_<dep_id>>: <files>
- ...

Hand back: a one-paragraph summary listing
1) the files you wrote,
2) any deviations from the task description and why,
3) whether `pnpm -F <package> typecheck` passes,
4) the commit SHA (or commit subject if SHA isn't easy to surface).

Do not write tests. Do not modify files outside target_files (other than the index.ts re-exports the description names). Do not paraphrase the spec — quote it.
```

## Picking the agent

Use the picker table from `SKILL.md`. When two signals match, prefer the more specific one. Examples:

- A task in `packages/cli/src/commands/` tagged `risk: low` → `cli-ux-engineer` (path beats risk).
- A task in `packages/core/src/runner/runner.ts` tagged `risk: high` → `systems-engineer`.
- A task in `packages/generator/templates/blank/flow.ts` → `flow-author` (path is more specific than the generic `task-implementer` default).

## Validating a wave

After all dispatched agents return, before starting the next wave:

1. **Read every changed file** (or just the diff via `git log -1 --stat`).
2. **Run typecheck** for each package the wave touched: `pnpm -F <pkg> typecheck`.
3. **If anything failed**, dispatch a follow-up to the agent that owned the failing file with the error output.
4. **If a task wrote files outside its `target_files`**, that's a deviation — flag in the wave summary.

## Code-review pass (after the last wave)

For any sprint that touched high-risk modules (Runner, ClaudeProvider, DAG, resume, auth), spawn `code-reviewer` over the diff. Send one Agent call with the file list and the spec sections. Capture the report; surface BLOCK findings to the user.

## Worked example (sprint 1, wave 1 — 5 parallel tasks)

```
Sprint 1 has one wave with 5 tasks: task_6 errors, task_7 atomic-write, task_8 logger,
task_9 zod re-export, task_10 provider types.

All five depend only on task_2 (which shipped in sprint 0). They share no files.
→ Dispatch all 5 in one message.

After the wave returns:
- pnpm -F @relay/core typecheck
- All five files exist? Re-exports in src/index.ts visible?
- code-reviewer pass on src/errors.ts and src/providers/types.ts
  (foundation types — drift here cascades).
```

## Anti-patterns to avoid

- **Sequential dispatch when tasks are parallel.** Always batch into one message.
- **Pre-fetching spec sections per task.** Trust the agent to read the spec; pre-quoting wastes your context.
- **Writing the code yourself instead of dispatching.** The orchestrator's job is to coordinate, not implement.
- **Skipping typecheck between waves.** A type error from wave 1 can fail every wave-2 task silently.
