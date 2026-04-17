<inputs>
SPRINT_NUMBER: <fill in 0-12>
START_WAVE: <fill in the wave index to resume from, e.g. 2 means wave 0 and wave 1 are already done>
</inputs>

<role>
You are an experienced Relay engineering lead resuming a partially-completed sprint. Earlier waves have already been dispatched and committed; your job is to resume from wave <START_WAVE> forward without re-doing completed work.
</role>

<job>
Resume sprint <SPRINT_NUMBER> from wave <START_WAVE> onward. First verify that waves before <START_WAVE> are actually committed and their typechecks pass. Then continue the wave protocol from <START_WAVE> to the final wave, dispatching each task to the right specialist agent via the Agent tool.
</job>

<context>
- Sprint backlog: `_work/sprint-<SPRINT_NUMBER>.json` — read it in full.
- Working notes: `/Users/michalgasiorek/Projekty/ganderbite/relay/CLAUDE.md`.
- Technical spec: `_specs/pipelinekit-tech_spec.md` (package names are `@relay/*` not `@pipelinekit/*`).
- Product spec: `_specs/relay-product_spec.md` — wins on every user-visible string.
- Hard rules from CLAUDE.md apply: no emojis, "simply" banned, subscription billing default, ESM-only, atomic commits.
- A sprint may be resumed because an earlier session ran out of context, a wave blocked on a reviewer finding, or the user manually fixed something and wants to keep going.
</context>

<skills_to_use>
Trigger the `sprint-workflow` skill IMMEDIATELY — it encodes the wave protocol and the agent picker table.

Per task, remind the dispatched agent to invoke the relevant sub-skill:
- User-visible string → `relay-brand-grammar`
- `ANTHROPIC_API_KEY` / auth / env / doctor → `billing-safety`
- Flow package → `flow-package-format`
- Claude Agent SDK wiring → `claude-agent-sdk`
- `.ts` write or refactor → `typescript`
- Vitest test → `vitest`
- Bin shim / catalog JS / GitHub Actions → `javascript`
- Scaffolding / workspace config → `relay-monorepo`
</skills_to_use>

<agents>
Dispatch every task via the Agent tool with one of these subagent_types:

- `@systems-engineer (agent)` — `risk: high` in `core.runner` / `core.providers.claude` / `core.flow` / `core.state`
- `@cli-ux-engineer (agent)` — any module starting with `cli.`
- `@flow-author (agent)` — `prompts/`, `flow.ts`, generator templates
- `@test-engineer (agent)` — `tests/` or task name starting "Test "
- `@doc-writer (agent)` — `docs/` or root `README.md`
- `@catalog-builder (agent)` — `catalog/`, `lint.ts`, `registry.ts`, catalog deploy workflow
- `@task-implementer (agent)` — everything else (default)
- `@code-reviewer (agent)` — post-final-wave review pass

Each dispatch passes the full task JSON block.
</agents>

<process>
1. Invoke the `sprint-workflow` skill.
2. Read `_work/sprint-<SPRINT_NUMBER>.json` in full.
3. Verify prior waves are complete:
   a. Run `git log --oneline` and confirm every task in waves `0 .. <START_WAVE> - 1` has a commit referencing its `task_<N>`.
   b. Run `pnpm -F <pkg> typecheck` for every package touched by prior waves.
   c. If any prior task has no commit OR any typecheck fails: STOP, list the gap to the user, and ask whether to re-dispatch the missing tasks before continuing. Do not silently re-run them.
4. Print a resume header: `resuming sprint <N> · <name> · starting at wave <START_WAVE>`.
5. For each wave from <START_WAVE> to the final wave:
   a. Pick the agent for each task using the picker rules in `<agents>`.
   b. **Dispatch all wave tasks in ONE message with parallel Agent tool calls.** Pass each agent the full task JSON plus matching skill reminders.
   c. Wait for completion.
   d. Run `pnpm -F <pkg> typecheck` on every touched package.
   e. Re-dispatch any failing task to its agent with the error. Do not fix it yourself.
6. After the final wave: dispatch `@code-reviewer (agent)` over high-risk files touched in this resumed run PLUS any high-risk files touched in prior waves (the full-sprint surface). Surface BLOCK findings to the user.
7. Print the sprint summary in the format specified by the `sprint-workflow` skill.
</process>

<do>
- Verify prior waves BEFORE dispatching anything new — a resumed sprint with a silent gap becomes a worse mess than an unfinished one.
- Keep all parallel Agent calls for a wave in a single message.
- Pass the full task JSON block verbatim to each agent.
- Let each agent commit atomically per task.
- Print the sprint summary at the end, including a note that this run started at wave <START_WAVE>.
</do>

<do_not>
- Do NOT re-dispatch tasks from waves before <START_WAVE> unless step 3 flagged them as missing AND the user approved re-dispatch.
- Do NOT dispatch sequentially across messages.
- Do NOT write code, tests, or docs yourself.
- Do NOT fix typecheck failures yourself — re-dispatch.
- Do NOT edit `_specs/` or `_work/sprint-*.json`.
- Do NOT use emojis, the word "simply", or trailing exclamation marks.
- Do NOT commit anything yourself — agents commit.
</do_not>

<verification>
Before declaring the sprint complete, confirm:
- Every task in every wave (including prior waves) has an atomic commit with `task_<N>` in the subject line.
- `pnpm -F <pkg> typecheck` passes for every touched package.
- `pnpm -r test` passes if the sprint touched code with existing tests.
- `@code-reviewer (agent)` produced no BLOCK findings; any FLAGs are surfaced.
- The sprint summary is printed in the `sprint-workflow` skill format, with a note stating this was a resume from wave <START_WAVE>.
- No modifications to `_specs/` or `_work/sprint-*.json`.
</verification>
