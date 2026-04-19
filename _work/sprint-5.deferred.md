# Sprint 5 · Deferred Review Findings

Each entry was marked `fix later` (or `needs spec`) in `_work/sprint-5.code_review.md`. Open as future sprint tasks.

## FLAG-2 · Live-state cadence is end-of-invocation, not per token-usage event
- **Severity:** FLAG
- **File:** `packages/core/src/runner/exec/prompt.ts:144,225`
- **Section:** §4.4.1 step 4 ("Update a per-step live state file every time we see a token-usage event")
- **Why deferred:** the real consumer is the sprint-6 CLI progress display. Better to switch `invoke()` → `stream()` + hoist the aggregator once we see the UX with live data. Track as a sprint-6 task; non-blocking for sprint 5.
- **Suggested fix:** switch `executePrompt` from `provider.invoke()` to `provider.stream()`, move the aggregator into the executor, and write live state on each `usage` event.

## FLAG-6 · Multiple concurrent `stateMachine.save()` calls can race; intermediate state.json can be stale after crash
- **Severity:** FLAG
- **File:** `packages/core/src/runner/runner.ts:678-701,808-814` + `packages/core/src/state.ts:266-281`
- **Section:** §8.5 atomic writes, §4.8.2 resume soundness
- **Why deferred:** worst case is a resumed run re-running a step already succeeded in memory. Bounded, non-billing. Track as a follow-up: add a writer queue analogous to `HandoffStore.#writeLocks`.
- **Suggested fix:** serialize `StateMachine.save()` through a single writer queue (memoize an in-flight promise and chain next call onto `.then(...)`, same pattern as `HandoffStore.#writeLocks`). Keeps every on-disk snapshot a monotonic prefix of in-memory history.

## FLAG-7 · Script/Branch executors forward full `process.env` including `ANTHROPIC_API_KEY`
- **Severity:** FLAG
- **File:** `packages/core/src/runner/exec/script.ts:46-50`, `packages/core/src/runner/exec/branch.ts:41-44`
- **Section:** §4.4.2, §4.4.3, §8.1.2 (subprocess containment)
- **Why deferred:** spec-compliant as written; the right response is documentation, not code. Track a doc task: a paragraph in the flow-package README making the §8.1 boundary explicit (prompt steps contained, script/branch steps are user-controlled shell with full env).
- **Suggested fix:** add a README section under the flow-package template explaining that prompt steps are contained per §8.1 but script/branch steps run user-controlled shell with full env. No code change.

## FLAG-8 · `enqueueReady` uses unbounded `queue.includes(candidate)` — O(N) per check, O(N²) per scan
- **Severity:** FLAG
- **File:** `packages/core/src/runner/runner.ts:704-734`
- **Section:** §4.9 step 8 (repopulate ready queue)
- **Why deferred:** scalability smell, not a bug. Revisit when a real flow pushes past ~50 steps.
- **Suggested fix:** replace `queue: string[]` + `.includes` with a parallel `Set` tracking enqueued ids, or use a `Set` as the queue and a separate `string[]` for ordering.

## FLAG-9 · `step.id` truth source is inconsistent between executors and dispatch
- **Severity:** FLAG
- **File:** `packages/core/src/runner/exec/prompt.ts:129`, `packages/core/src/runner/exec/script.ts:26,32`, `packages/core/src/runner/exec/branch.ts:21,27`
- **Section:** §4.4 (each step carries an `id` injected at flow compile time)
- **Why deferred:** pure cleanup. Fold into a later refactor pass that removes the Omit-and-rebind pattern across script/branch/prompt and standardizes on `ctx.stepId`.
- **Suggested fix:** remove the `Omit<..., 'id'> & { id?: string }` gymnastics in script/branch; standardize every executor on `ctx.stepId` (which is always defined at dispatch time).

## FLAG-13 · Resume does not reject when `persistedState.status === 'succeeded'` or `'aborted'`
- **Severity:** FLAG
- **File:** `packages/core/src/runner/runner.ts:299-383`
- **Section:** §4.8.2
- **Why deferred:** low-impact edge case. Once FLAG-12 ships, add a short early-return on `status === 'succeeded'` and decide the `'aborted'` policy alongside the FLAG-11 spec amendment.
- **Suggested fix:** guard `resume(runDir)` — if state.status === 'succeeded' return the existing result; if 'aborted' and user wants to retry, require caller to explicitly reset. Depends on FLAG-11 amendment landing first.

---

## Needs spec (deferred per user directive)

### FLAG-11 · `RunResult.status` adds `'aborted'` beyond the spec's `'succeeded' | 'failed'`
- **Severity:** FLAG
- **File:** `packages/core/src/runner/runner.ts:68` + `runner.ts:230,284,406,461`
- **Section:** §4.9 (`RunResult.status: 'succeeded' | 'failed'`)
- **Why deferred:** aborted is a real, user-visible outcome (product §6.6 `⊘`, §11.5 ctrl-c paused display). Raise a spec amendment to extend §4.9 `RunResult.status` to `'succeeded' | 'failed' | 'aborted'`. No code change; do not collapse to `'failed'`. User opted to defer the spec amendment and proceed with codebase fixes only in this session.
- **Suggested fix:** amend `_specs/pipelinekit-tech_spec.md` §4.9 `RunResult.status` union to include `'aborted'`, then cross-link product §6.6 / §11.5. Implementation is already correct.
