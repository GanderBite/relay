# Sprint 47 · step.ask at every flow shape — parallel, loop body, and updated templates — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `ef7af89` (feat(core): foundation for ask-in-parallel and ask-in-loop)
- `b9f09d0` (feat(core): StateMachine body-step state seeding and sweep)
- `4323784` (feat(core): executeLoop callbacks for mid-iteration resume)
- `946310a` (feat(core): wire ask-in-loop body and refresh generator templates)
- `2f2e652` (fix(core): preserve awaitingInput across resume sweep for body-step asks)
- `a200c38` (test: ask in parallel branch, loop body, and CLI iteration path routing)

**Summary:** 1 BLOCK, 9 FLAG, 22 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Section A — Parallel ask handling: DAG validator and sibling sweep

### A.1 — `validateParallelAskQuota` rejects two ask steps reachable from the same parallel barrier — **PASS**

- `packages/core/src/flow/graph.ts:589-643` walks each parallel step's reachable subgraph via BFS over the `successors` map. When the count of reachable ask steps exceeds 1, it returns a typed `FlowDefinitionError` whose message names the parallel id and every offending ask id, e.g. `parallel step "fan" has 2 concurrent ask steps in its branches (ask-a, ask-b): concurrent asks are not supported — sequence them before or after the barrier.`
- The walk descends into loop bodies through `collectLoopBodyAsks` (`graph.ts:650-661`), so an ask buried inside a loop body still counts toward the quota for the enclosing parallel barrier.
- `buildGraphInternal` calls the validator after `validateAskQuestionSources` (`graph.ts:181-182`); the error short-circuits the build before any frozen graph is returned.
- Tests at `packages/core/tests/flow/ask.test.ts:351-462` cover all four task-required cases — the rejection-with-id-list case, the one-ask-one-prompt success case, the loop-body-ask-inside-parallel rejection case, and the loop-body-ask-without-parallel success case.
- **Decision:**

### A.2 — Sibling sweep on pause flips running siblings to pending — **PASS**

- `packages/core/src/orchestrator/orchestrator.ts:1634-1668` iterates every entry in `stateMachine.getState().steps`, skips the pausing step, and for each `running` sibling chains `failStep('aborted by sibling pause') → resetStep`. The single `pauseSave` at line 1669 persists the sweep atomically alongside the pause flip.
- The intermediate `failed` state never lands on disk — both StateMachine transitions mutate in-memory only, and the `save()` call at line 1669 takes a snapshot of the post-reset state.
- `packages/core/tests/orchestrator/ask-parallel.test.ts:316-348` (Suite 2) explicitly exercises the slow-prompt-branch + fast-ask-branch case: with a 200 ms delay on the prompt branch, the test asserts `state.steps['promptBranch']?.status === 'pending'` after pause, never `running`. A second test at line 384-426 verifies that the swept-to-pending sibling actually re-runs on resume rather than being skipped.
- **Decision:**

### A.3 — Loop step status lifecycle on body-step ask pause — **PASS**

- When a body-step ask throws `AwaitingInputSignal`, the runBodyStep catch (`orchestrator.ts:1460-1470`) re-targets the signal's `stepId` to the synthesised body-step state key. The signal bubbles up through executeLoop → withRetry → dispatchStep's catch (`orchestrator.ts:1596-1694`).
- `pauseStep` is invoked with the synthesised key (which exists in state.json because `seedBodyStep` + `startStep` ran before executeAsk). The loop step itself is in 'running' status at this point, but the sibling sweep at `orchestrator.ts:1634-1668` catches it on the same iteration of the steps map and chains failStep → resetStep, landing it at 'pending'. The save at line 1669 persists both transitions atomically.
- On resume, `seedReadyQueueForResume` (`packages/core/src/orchestrator/resume.ts:156-189`) re-queues the loop step as a normal predecessors-satisfied entry, and executeLoop re-enters at the paused iteration via `getResumedIter`.
- The JSDoc on `seedReadyQueueForResume` (`resume.ts:130-155`) documents the synthesised-id exclusion and the reliance on the pause-time sibling sweep.
- **Decision:**

### A.4 — Loop step's `attempts` counter inflates by one per pause/resume cycle — **FLAG-1**

- **File:** `packages/core/src/orchestrator/orchestrator.ts:1640-1668`, interaction with `state.ts:156-175` (`startStep`) and `state.ts:276-300` (`resetStep`).
- **Spec / decision:** Implicit invariant — the `attempts` counter on a loop (or any non-paused sibling) step should track real executor invocations, not pause-resume bookkeeping. Per memory rule on `attempts`: `attempts` is preserved across resume so retry budgets carry; this is contradicted by the sweep chain incrementing on every pause cycle.
- **Finding:** When a body-step ask pauses, the sibling sweep walks `stateMachine.getState().steps` and chains `failStep → resetStep` against the enclosing loop step (status was `running`, becomes `failed` then `pending` — `attempts` preserved at the value `startStep` set on the original dispatch, e.g. 1). On resume, `seedReadyQueueForResume` enqueues the loop step; `dispatchStep` calls `startStep(loopId)` which increments `attempts` to 2 (`state.ts:172`). After a second pause cycle, `attempts === 3`. The `Math.max(0, maxRetries - priorAttempts)` clamp at `orchestrator.ts:1564` then erodes the retry budget by one per cycle. For the default `maxRetries: 0` (loop, parallel — see `stepRetryBudget` at `orchestrator.ts:1495-1498`) this is purely cosmetic — the clamp value is `Math.max(0, 0 - N) = 0` and the initial dispatch is unaffected. For loop steps configured with `maxRetries > 0`, every pause cycle eats one retry. The same inflation hits any non-ask sibling parallel branch that the sweep flips back to pending: branches with `maxRetries > 0` will see their budget burned across pauses.
- **Suggested fix:** In the sibling sweep at `orchestrator.ts:1634-1668`, after the `resetStep` call, decrement `attempts` by one to compensate for the `startStep` re-increment on the next dispatch. Either expose a `resetStep` variant that takes a `decrementAttempts: boolean` option, or sweep with the existing `resumePausedStep`-style decrement after the failStep→resetStep chain. Concrete sketch:
  ```ts
  const resetSibling = stateMachine.resetStep(siblingId);
  if (resetSibling.isErr()) { /* log + continue */ }
  // Compensate for the incremented startStep on the next dispatch.
  // The sibling's prior dispatch was aborted before completion — it does
  // not count as a real retry attempt.
  const decrementAttempts = (id: string): void => { /* StateMachine helper */ };
  decrementAttempts(siblingId);
  ```
  Pair with a new state.test.ts case asserting that after N pause-resume cycles, `state.steps[loopId]?.attempts === 1` (matching the single real dispatch), not N+1.
- **Decision:**

### A.5 — `stepId.includes('::')` discriminator is sound only because step ids cannot legitimately contain `::` — **FLAG-2**

- **File:** `packages/core/src/orchestrator/orchestrator.ts:601-608`
- **Spec / decision:** Code quality / defensive coding. Concern #7 from the briefing.
- **Finding:** The resume-paused-step branch decides whether to preserve `awaitingInput` by checking `stepId.includes('::')` to distinguish synthesised body-step keys (`<loopStepId>::<bodyStepId>`) from top-level step ids. The discriminator works today because handoff ids are validated against `HANDOFF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/` (`packages/core/src/handoffs.ts:18`), which rejects `:` characters — and the prompt-step `output.handoff` field flows through `validateHandoffId`. But step ids themselves are validated only as `nonEmptyString` in `packages/core/src/flow/schemas.ts:18-19` (used for `stepId` at line 19). A user who names a top-level step `foo::bar` would pass schema validation, and the resume branch would mistakenly preserve `awaitingInput` for that step. The runtime behaviour for that contrived case is benign (the loop-context fields are absent on the awaitingInput record so `getResumedIter` would return `undefined`), but the discriminator is brittle and the code comment at `orchestrator.ts:589-595` does not warn the next maintainer about the constraint.
- **Suggested fix:** Tighten the `stepId` schema in `packages/core/src/flow/schemas.ts:19` to apply the same `HANDOFF_ID_PATTERN` regex (or a similar one that rejects `:`), so the synthesised separator is provably exclusive to body-step keys. Add a comment at `orchestrator.ts:602` noting the dependency:
  ```ts
  // The '::' substring is reserved for synthesised body-step keys
  // (StateMachine.bodyStepStateKey). Top-level step ids cannot legitimately
  // contain '::' because the stepId schema rejects ':' characters; see
  // packages/core/src/flow/schemas.ts.
  const isBodyStepKey = stepId.includes('::');
  ```
  Alternatively, expose `StateMachine.isBodyStepStateKey(id)` so the discriminator lives in one place rather than as a string-includes scattered across the codebase.
- **Decision:**

### A.6 — Non-ask body steps re-run on every resume because they are never seeded — **FLAG-3**

- **File:** `packages/core/src/orchestrator/orchestrator.ts:1411-1414` (`runBodyStep` early return), `orchestrator.ts:1350-1354` (`isBodyStepSucceeded`).
- **Spec / decision:** Concern #2 from the briefing — the systems engineer flagged this during implementation. Implicit constraint: deterministic resume should not silently re-invoke body steps that succeeded on a prior pass.
- **Finding:** `runBodyStep` only seeds and tracks state for `bodyStep.kind === 'ask'`; every other kind (prompt, script, branch, parallel) returns directly from `runExecutor(bodyStep, 1)` at `orchestrator.ts:1413` with no synthesised state entry. As a result, `isBodyStepSucceeded` (which queries `stateMachine.getState().steps[bodyStepStateKey(...)]`) returns `false` for every prompt body step on resume. The skip path in `executeLoop` (`packages/core/src/orchestrator/exec/loop.ts:237-262`) is therefore never taken for non-ask body steps, and they re-run on every pause-resume cycle. This is documented in the test at `packages/core/tests/orchestrator/ask-loop.test.ts:184-207` as the intended behaviour ("non-ask body steps always re-run on resume"), but the design choice has consequences for prompt steps that are not idempotent: they re-spend tokens, re-write artifacts, and could produce a different handoff value than the prior pass. The until-condition then evaluates against the new handoff, not the original. For the loop template's `implement → feedback → review` shape this means iterating through `implement` re-runs every time the user pauses on `feedback` — token cost scales linearly with pause count, not iteration count.
- **Suggested fix:** Either (a) document the re-run semantics explicitly in the loop builder JSDoc and template README, advising authors that body prompt steps should be idempotent and that the answer file is the only persistent state across pause cycles; or (b) extend `runBodyStep` to seed/track every body step kind, not just ask, so `isBodyStepSucceeded` correctly short-circuits already-completed prompt steps. Option (b) is the deterministic fix but requires extending startStep/completeStep/failStep flow into the non-ask runBodyStep path. Concrete sketch for (b):
  ```ts
  const synthesisedKey = StateMachine.bodyStepStateKey(loopStepId, bodyStepId);
  const seedResult = stateMachine.seedBodyStep(loopStepId, bodyStepId, loopIter);
  if (seedResult.isErr()) throw seedResult.error;
  const startResult = stateMachine.startStep(synthesisedKey);
  if (startResult.isErr()) throw startResult.error;
  try {
    const result = await runExecutor(bodyStep, 1);
    const completeResult = stateMachine.completeStep(synthesisedKey, stepCompletionOutput(result));
    if (completeResult.isErr()) throw completeResult.error;
    await stateMachine.save();
    return result;
  } catch (caught) {
    // failStep, save, rethrow
    throw caught;
  }
  ```
- **Decision:**

### A.7 — `sweepBodySteps` deviates from "call resetStep for each entry" by chaining failStep→resetStep and writing fresh entries for terminal statuses — **FLAG-4**

- **File:** `packages/core/src/state.ts:541-583`
- **Spec / decision:** Concern #3 from the briefing. The task brief said "call resetStep for each entry"; the implementation routes through three different paths depending on existing status.
- **Finding:** `resetStep` accepts only `failed`-status entries (`state.ts:280-287`); applying it directly to entries in `running`, `succeeded`, `paused`, or `skipped` would return a `StateTransitionError`. The implementation handles each status separately:
  - `pending`: skip (already at target).
  - `running`: chain `failStep('iteration boundary sweep') → resetStep`.
  - `failed`: call `resetStep` directly.
  - `succeeded` / `paused` / `skipped`: write a fresh `{ status: 'pending', attempts: 0, iter? }` directly via `#updateStep`, bypassing the transition graph.
  The hybrid is sound: the intermediate `failed` state never hits disk because `sweepBodySteps` mutates in-memory only and the caller (`onIterationStart` in `orchestrator.ts:1316-1349`) calls `save()` after the sweep returns. The `#stepResults.delete(key)` at line 580 invalidates cached executor results for the rewritten entry. The deviation from the task spec is justified — the behaviour is "total reset" semantics, not transition-graph fidelity, and the JSDoc at `state.ts:541-555` calls this out explicitly. The risk is a future maintainer adding a transition (e.g. a 'cancelled' status) and forgetting to update the sweep's switch. A small unit test in `state.test.ts` asserting the post-sweep status for each starting status would close the gap.
- **Suggested fix:** Add a unit test in `packages/core/tests/state.test.ts` asserting `sweepBodySteps` post-state for each of the seven status starting points (`pending`, `running`, `succeeded`, `failed`, `paused`, `skipped`, missing). The test would lock in the hybrid behaviour and catch any future status addition that breaks the contract. No source change required — the implementation is correct as designed.
- **Decision:**

---

## Section B — Loop body ask: StateMachine machinery, executeLoop callbacks, orchestrator wiring, resume preservation

### B.1 — `bodyStepStateKey` / `seedBodyStep` / `sweepBodySteps` — **PASS**

- `packages/core/src/state.ts:513-515` defines `bodyStepStateKey(loopStepId, bodyStepId)` returning `<loopStepId>::<bodyStepId>` with JSDoc explaining the reserved separator.
- `seedBodyStep` (`state.ts:527-539`) is a same-iter no-op when an entry exists, otherwise inserts `{ status: 'pending', attempts: 0, iter }`. Pure in-memory; caller saves.
- `sweepBodySteps` (`state.ts:556-583`) walks every entry whose key matches the `loopStepId + '::'` prefix and resets each to `{ status: 'pending', ..., iter? }`. See FLAG-4 for the hybrid transition path.
- All three are public methods on the existing `StateMachine` class; no new public class added.
- **Decision:**

### B.2 — `executeLoop` callbacks: `getResumedIter`, `onIterationStart`, `isBodyStepSucceeded` — **PASS**

- `packages/core/src/orchestrator/exec/loop.ts:23-59` extends `LoopExecutorContext` with the three optional callbacks, each documented with the resume semantic it supports.
- The loop header now reads `for (let iter = startIter; iter <= maxIterations; iter += 1)` where `startIter = ctx.getResumedIter?.() ?? 1` (`loop.ts:201-203`). The change is fully backward-compatible — when callbacks are absent the behaviour matches the prior implementation.
- `onIterationStart` is invoked at the top of every iteration after the abort check (`loop.ts:208`), giving the orchestrator a hook to sweep body-step state.
- The skip path at `loop.ts:237-262` checks `isBodyStepSucceeded`, then reconstructs the iteration's handoff names from the body-step spec output (prompt → `output.handoff`, ask → step id) and pushes any names whose iteration-scoped handoff file already exists onto `iterHandoffs`. Read errors are silently dropped — see FLAG-5.
- **Decision:**

### B.3 — `runBodyStep` ask-path wiring: synthesised state entry, iteration-scoped answer path, signal re-targeting — **PASS**

- `packages/core/src/orchestrator/orchestrator.ts:1406-1471` implements the ask-body-step path:
  1. Compute `synthesisedKey = StateMachine.bodyStepStateKey(loopStepId, bodyStepId)`.
  2. `seedBodyStep` + `startStep(synthesisedKey)` (lines 1418-1421) before invoking executeAsk.
  3. `executeAsk(bodyStep, ..., askIterationAnswerHandoffPath(runDir, loopStepId, loopIter, bodyStepId))` (lines 1424-1430) — passes the iteration-scoped path as the fifth argument so the resume read targets the right file.
  4. On success: write the answer-map handoff under the bare body step id, call `completeStep(synthesisedKey, { handoffs: [bodyStep.id] })`, save, return AskStepResult.
  5. On `AwaitingInputSignal` catch: re-target `caught.stepId` to the synthesised key and attach `caught.loopContext = { loopStepId, loopIter }` so the outer dispatch catch can call `pauseStep` with loop-context fields.
- The signal mutation is deliberate and the only reader downstream is `dispatchStep`'s catch (`orchestrator.ts:1596-1694`), which extracts `caught.loopContext?.loopStepId` and `caught.loopContext?.loopIter` to pass through the new optional `pauseStep` parameters.
- **Decision:**

### B.4 — Resume sweep preserves `awaitingInput` for body-step paused entries — **PASS**

- `packages/core/src/orchestrator/orchestrator.ts:597-608` discriminates synthesised body-step keys via `stepId.includes('::')` and passes `preserveAwaitingInput: isBodyStepKey` to `resumePausedStep`.
- `state.ts:326-358` (`resumePausedStep`) honours the option: when `preserveAwaitingInput === true`, the `awaitingInput` field is left intact across the paused-to-pending flip.
- `state.ts:184-228` (`completeStep`) clears `awaitingInput` when the resumed body step actually consumes the supplied answer, so the pointer's lifecycle is bounded by the round-trip.
- `state.ts:336-347` also preserves `iter` on the resumed entry (`if (step.iter !== undefined) next.iter = step.iter`) so the synthesised body-step key keeps its iteration tag — `seedBodyStep` short-circuits to a no-op on the re-entry.
- See FLAG-2 for the discriminator brittleness.
- **Decision:**

### B.5 — `executeLoop`'s `getResumedIter` reads from `awaitingInput.loopIter` — **PASS**

- `packages/core/src/orchestrator/orchestrator.ts:1304-1308` wires `getResumedIter` to read `awaitingInput.loopIter` only when `awaitingInput.loopStepId === step.id`. Other loop steps' callers see `undefined` and start at iter 1.
- The matching `onIterationStart` at `orchestrator.ts:1316-1349` gates the body-step sweep on `iter > resumedIter` so the resumed iteration's already-succeeded body steps survive the boundary.
- The two-iteration round-trip test (`packages/core/tests/orchestrator/ask-loop.test.ts:254-367`) verifies the resume hooks correctly: after writing iter 1's answer, the resume re-runs `implement` for iter 1 (returns false), then iter 2 (returns false), pauses at iter 2's `feedback`. After writing iter 2's answer, the second resume re-runs iter 2 `implement` (returns true), the until matches, run succeeds. `awaitingInput.loopIter` correctly advances from 1 → 2 → cleared.
- **Decision:**

### B.6 — Iteration handoff replay in skip path silently swallows readIteration errors — **FLAG-5**

- **File:** `packages/core/src/orchestrator/exec/loop.ts:255-260`
- **Spec / decision:** Concern #10 from the briefing.
- **Finding:** When `isBodyStepSucceeded` reports a body step succeeded on a prior pass, the loop reads the iteration-scoped handoff file via `ctx.handoffStore.readIteration(step.id, iter, name)` and pushes the name onto `iterHandoffs` only when `readResult.isOk()`. Any read error — ENOENT, EACCES, JSON parse failure, schema mismatch — is silently dropped. The comment at `loop.ts:233-236` calls this best-effort, justifying the choice on the assumption that "a successful body step that produced no handoff contributes nothing to the iteration handoff set anyway." For ENOENT this is correct: a script body step with no `output.handoff` would never write a handoff file. For EACCES or schema mismatch on a prompt step that DID write its handoff, the silent drop hides the corruption — the until-condition evaluates against a stale `latest` pointer, and the loop may run an extra iteration or terminate early without surfacing the disk error to the operator.
- **Suggested fix:** Discriminate on the read-error variant. ENOENT remains a silent drop (the body step legitimately produced no handoff); other variants log a warn-level breadcrumb and either surface the error or continue with a recorded note. Concrete sketch:
  ```ts
  for (const name of skippedHandoffNames) {
    const readResult = await ctx.handoffStore.readIteration(step.id, iter, name);
    if (readResult.isOk()) {
      iterHandoffs.push(name);
    } else {
      // ENOENT is the expected case — a body step without a handoff
      // produces no iteration file. Other errors signal corruption that
      // the operator should see, not silent loop-cycle drift.
      const errno = (readResult.error as HandoffIoError).details?.errno;
      if (errno !== 'ENOENT') {
        ctx.logger.warn(
          { event: 'loop.iteration.replay_failed', stepId: step.id, bodyStepId, iter, name, error: readResult.error.message },
          'iteration handoff replay failed; the until condition may diverge',
        );
      }
    }
  }
  ```
- **Decision:**

### B.7 — `AwaitingInputSignal` `stepId` made mutable + new `loopContext` — **PASS**

- `packages/core/src/errors.ts:884-906` widens the class: `stepId` is now mutable (`public stepId: string`) and `loopContext` is a public optional field. The JSDoc at lines 889-894 calls out the single-site mutation in `runBodyStep` and explicitly notes that "every other reader treats the signal as immutable."
- Grep across `packages/core/src` and `packages/cli/src` shows the only writers are `orchestrator.ts:1466-1467` (the runBodyStep catch); the only reader paths are `orchestrator.ts:1610-1614` (pauseStep call) and `1634/1687` (sibling sweep + log). No external code depends on the prior `readonly` contract.
- **Decision:**

### B.8 — `pauseStep` extended with optional `loopStepId` / `loopIter` — **PASS**

- `packages/core/src/state.ts:373-411` adds two optional positional parameters. Backward compatible — existing top-level ask callers pass neither and the awaitingInput record stores only the original three fields. The `AwaitingInput` schema at `state.ts:40-46` mirrors the optional fields.
- The single new caller in `orchestrator.ts:1609-1615` threads `caught.loopContext?.loopStepId` and `caught.loopContext?.loopIter` through. When the signal has no `loopContext` (top-level ask), both arguments are `undefined` and the spread operators in `pauseStep` produce the legacy three-field record.
- The task brief authorised the cross-file scope deviation (`task_106`'s target_files originally listed only `orchestrator.ts`); the change is sound.
- **Decision:**

---

## Section C — Generator templates: linear, fan-out, loop

### C.1 — Linear template gains a leading `gather` ask step — **PASS**

- `packages/generator/templates/linear/flow.ts:24-38` is exactly three steps: `gather` (ask) → `{{stepNames[0]}}` (prompt, dependsOn + contextFrom = ['gather']) → `{{stepNames[1]}}` (prompt). The third prompt step from the prior template was removed, the `description` updated.
- README.md `What it does` (line 7) describes the pause-then-answer start, the `Run` section adds a `Pause and answer` subsection (line 32-50) showing both interactive and `--json` invocation. No emojis, no `simply`, no trailing exclamations.
- **Decision:**

### C.2 — Fan-out template moves prep to a `gather` ask step before the barrier — **PASS**

- `packages/generator/templates/fan-out/flow.ts:33-64` has `gather` as the entry, both branches dependsOn + contextFrom on `gather`, the `barrier` step preserves `branches: ['branch_a', 'branch_b']`, and `merge` reads `gather`, `branch_a`, `branch_b` via contextFrom.
- The `start: 'gather'` at line 31 makes the entry point explicit.
- README.md `What it does` (line 8-15) explains the topology; the topology diagram (lines 17-20) shows `gather` upstream of the barrier; the explainer at lines 22-25 explicitly states why ask steps inside parallel branches are forbidden.
- The `Run` section (lines 76-98) shows both interactive and `--json` invocation. The `Customization` section's last bullet (lines 159-162) reminds authors to keep ask steps before the barrier.
- No emojis, no `simply`, no trailing exclamations.
- **Decision:**

### C.3 — Loop template adds a `feedback` ask body step between `implement` and `review` — **PASS** (with one BLOCK below)

- `packages/generator/templates/loop/flow.ts:22-48` body: `implement` (prompt, contextFrom: ['review?', 'feedback?']) → `feedback` (ask, dependsOn: ['implement']) → `review` (prompt, dependsOn: ['feedback'], contextFrom: ['implementation', 'feedback']). The until condition still reads `review.decision`.
- `ReviewSchema` export is unchanged; `until.from === 'review'`.
- README.md `What it does` (lines 5-9) describes the three-step body and per-iteration ask. The `Run` section adds a `Pause and answer each iteration` subsection (lines 34-42).
- No emojis, no `simply`, no trailing exclamations.
- **Decision:**

### C.4 — Loop template README documents an invented CLI flag that does not exist — **BLOCK-1**

- **File:** `packages/generator/templates/loop/README.md:36-42`
- **Spec / decision:** Brand-grammar / docs accuracy. The product spec is canonical for visible CLI invocation lines. `relay answer` only accepts `--json <jsonString>` per `packages/cli/src/dispatcher.ts:174-181`.
- **Finding:** The README's `Pause and answer each iteration` section instructs the operator to run `relay answer <run-id> --comments "looks good, tighten the error handling"`. This flag does not exist. The actual CLI signature at `dispatcher.ts:177` is `.option('--json <jsonString>', 'answers as a JSON object string (non-interactive)')` — there is no per-question-id flag, only `--json '{"comments":"..."}'`. An operator who copies the README example will see commander reject the unknown option and the run will not advance. Lines 38-40 would also need to be revised so the README explains that `feedback` answers are submitted as a JSON map.
- **Suggested fix:** Replace lines 36-42 with the same two-block invocation pattern used by the linear and fan-out templates:
  ```markdown
  Each iteration of the loop pauses after `implement` and waits for you to answer one question — `comments`, a free-form note on the implementation. The CLI prints the run id and the prompt; in another terminal, answer interactively with:

  ```bash
  relay answer <runId>
  ```

  Or pass the answer non-interactively:

  ```bash
  relay answer <runId> --json '{"comments":"looks good, tighten the error handling"}'
  ```

  Leave the `comments` field empty (`--json '{"comments":""}'` or hit Enter at the interactive prompt) to approve the iteration without notes — `review` will still run and decide `continue` or `done`.
  ```
- **Decision:**

### C.5 — Loop template's body re-runs `implement` on every resume; the README does not warn about this — **FLAG-6**

- **File:** `packages/generator/templates/loop/README.md:5-9` (`What it does`), `packages/generator/templates/loop/flow.ts:22-48`.
- **Spec / decision:** Operator-facing accuracy. Tied to FLAG-3 (non-ask body steps re-run on resume).
- **Finding:** Per FLAG-3, the orchestrator re-invokes `implement` on every resume because non-ask body steps are not seeded into state. For the default loop topology this means a single iteration that pauses on `feedback` will run `implement` once on the first pass and at least once more on the resume — doubling the token cost per iteration relative to what an unattended loop would spend. The README's `Estimated cost and duration` ($0.10–$1.00 per run, lines 16-18) does not reflect this multiplier. Operators following the cost guidance will see materially higher bills than estimated, especially on tasks that take 3+ iterations.
- **Suggested fix:** Either (a) bump the cost estimate to 1.5–2× and add a paragraph under `Estimated cost and duration` noting the resume re-run behaviour, or (b) hold this finding until FLAG-3 is decided — if the deterministic-resume fix lands, the README is correct as written. Concrete sketch for (a):
  ```markdown
  - **Cost:** $0.20–$2.00 per run on the default sonnet model (billed to your subscription on Pro/Max). Each pause-resume cycle re-runs the `implement` prompt for that iteration before the loop advances, so cost scales with `iterations × (1 + pauses per iteration)` rather than iterations alone. Keep `feedback` short or set `maxIterations` to a tight bound to keep the multiplier small.
  ```
- **Decision:**

---

## Section D — Test matrix: coverage, MockProvider correctness, fixture quality

### D.1 — Parallel ask coverage (`tests/orchestrator/ask-parallel.test.ts`) — **PASS**

- The file exposes two suites: "sibling completes before pause" (4 tests, lines 135-250) and "sibling aborted mid-flight" (5 tests, lines 266-427) — together 9 cases covering the timing-sensitive sweep behaviour.
- Suite 1 leans on the loose acceptance set `['succeeded', 'pending']` for the sibling status (line 188) since the sibling may finish before the pause depending on scheduling. The harder guarantee — no step ever stuck in `running` — is asserted independently at lines 180-184. This is the right way to handle timing nondeterminism: lock in the safety invariant, accept either acceptable terminal state.
- Suite 2 forces the sweep path with an explicit 200 ms delay (line 296), so the assertion at line 332 (`promptBranch === 'pending'`) is deterministic under load.
- The "promptBranch is re-invoked after resume" test at line 384-426 uses a fresh `createOrchestrator` with a tracking registry on resume to prove the sibling actually re-runs (not just transitions to a non-pending status). This catches a regression where the sweep would mark the sibling completed instead of pending.
- Uses `MockProvider`, temp-dir + retry-on-cleanup pattern, parses state.json directly.
- **Decision:**

### D.2 — DAG validator coverage (`tests/flow/ask.test.ts:347-463`) — **PASS**

- Four test cases cover all task-required scenarios (per acceptance criteria for task_113):
  1. Two asks in different branches — throws FlowDefinitionError with the parallel id and both ask ids in the message (lines 351-387).
  2. One ask + one prompt in branches — succeeds (lines 389-403).
  3. Ask inside a loop body inside a parallel branch + sibling ask — throws (lines 405-435).
  4. Ask inside a loop body with no parallel ancestor — succeeds (lines 437-462).
- The first case asserts every relevant message field — the error type (`FlowDefinitionError`), the parallel step id (`fan`), both ask ids (`ask-a`, `ask-b`), and the human-readable phrase (`concurrent asks are not supported`). A future refactor that drops one of these would fail the test loudly.
- **Decision:**

### D.3 — Loop body ask coverage (`tests/orchestrator/ask-loop.test.ts`) — **PASS**

- Three tests cover the spec-required scenarios (per acceptance criteria for task_114):
  1. State.json shape after pause — verifies synthesised key `fix_loop::feedback`, awaitingInput.loopStepId/loopIter populated, answer file does not exist yet (lines 140-177).
  2. Mid-iteration resume — verifies implement re-runs (FLAG-3 behaviour), feedback resolves from answer file, until matches, run succeeds (lines 183-248).
  3. Two-iteration round-trip — verifies the full sequence with iteration-scoped answer files, distinct file paths per iteration, awaitingInput.loopIter advancing 1 → 2 → cleared (lines 254-367).
- The mid-iteration test's docblock at lines 184-187 explicitly documents the non-ask re-run behaviour, locking in the contract from FLAG-3 even if a future change accidentally re-introduces seeding.
- The two-iteration test at line 265 uses an explicit response queue (`[false, false, false, true]`) rather than a counter threshold, making the implement call sequence unambiguous.
- Uses `MockProvider`, temp-dir + retry-on-cleanup, `askIterationAnswerHandoffPath` for path computation, `atomicWriteJson` for the answer write.
- **Decision:**

### D.4 — CLI iteration-scoped path routing coverage (`packages/cli/tests/commands/answer.test.ts:306-374`) — **PASS**

- Two tests cover both branches (per acceptance criteria for task_115):
  1. `loopStepId + loopIter` set → file written under `<runDir>/handoffs/fix_loop/iter_1/__ask_feedback__.json` (asserts every path segment).
  2. `loopStepId` absent → file written under `<runDir>/handoffs/__ask_gather__.json`, explicitly NOT containing `iter_` (line 372).
- Mocks `loadState` with the appropriate awaitingInput shape; asserts `mockAtomicWriteJson` was called with the right path. Uses the same mock infrastructure as the rest of the answer tests, no per-test shimming.
- **Decision:**

### D.5 — Test fixture parity with in-test flow factories — **PASS**

- The orchestrator-level tests use both an inline factory (`makeAskParallelFlow`, `makeAskLoopFlow`) and a fixture file imported by `Orchestrator.resume()` for re-import on resume. The fixtures at `packages/core/tests/orchestrator/fixtures/ask-parallel-flow.ts` and `ask-loop-flow.ts` mirror the inline factory shape exactly, so the resume path tests the same flow definition the run path used.
- **Decision:**

---

## Project constraint verifications

### All fallible public functions return `Result<T,E>` via neverthrow — **PASS**

- New StateMachine methods (`seedBodyStep`, `sweepBodySteps`) return `Result<void, StateTransitionError>` (`state.ts:531, 556`).
- `executeAsk` retains its `Promise<Result<AnswerMap, AskExecError>>` signature; the new `answerPath` parameter does not change the result shape.
- `executeLoop`'s new optional callbacks return either a Promise<void> or a primitive; none return a Result, but `executeLoop` itself remains the throw-and-catch boundary at the loop level (consistent with the existing `LoopMaxIterationsError` throw at `loop.ts:328`).
- The single intentional throw in core (`AwaitingInputSignal`) is documented as a control-flow signal in `errors.ts:884-906` and has not been widened.
- **Decision:**

### No emojis in any output, code, or template — **PASS**

- Searched `packages/core/src/state.ts`, `orchestrator/exec/ask.ts`, `orchestrator/exec/loop.ts`, `orchestrator/orchestrator.ts`, `orchestrator/resume.ts`, `flow/graph.ts`, `flow/types.ts`, `errors.ts`, `cli/src/commands/answer.ts`, all three template flow.ts and README.md files. No emoji code points. Symbol vocabulary (`✓ ✕ ⚠ ⊘ ●─▶ ○ ·`) sourced from `SYMBOLS` and `MARK`.
- **Decision:**

### `simply` does not appear in any user-visible string — **PASS**

- `grep -nE '\bsimply\b'` across all sprint-47 source and template files returns one hit at `packages/cli/src/brand.ts` — a comment listing the banned word as a banned word, not a use. Zero hits in any output, README, or template.
- **Decision:**

### No trailing exclamation marks in user-visible copy — **PASS**

- `grep -nE '!'` across the three template README.md files returns zero hits.
- **Decision:**

### Atomic writes for any file other processes might read — **PASS**

- All state.json writes go through `atomicWriteJson` via `StateMachine.save()` (`state.ts:457-471`) — the new sweep methods (`seedBodyStep`, `sweepBodySteps`) are pure in-memory mutations whose persistence is the caller's responsibility, and the orchestrator calls `save()` after the sweep at `orchestrator.ts:1336-1343` and `1444-1451`.
- The CLI's iteration-scoped answer file write goes through `atomicWriteJson` (`answer.ts:315`).
- **Decision:**

### Self-contained code comments — no spec refs, no sprint/task IDs — **PASS**

- `grep -nE '§[0-9]'` across all sprint-47-modified files returns zero hits.
- `grep -nE 'task_|FLAG-|BLOCK-'` across the same set returns zero hits.
- The previously-flagged pre-existing `§` references in `packages/cli/src/commands/resume.ts` and `packages/cli/src/paused-banner.ts` were untouched in sprint 47 and remain in the "Other follow-ups" carry-over.
- **Decision:**

### Domain-generic error names — **PASS**

- No new error classes added in sprint 47. Existing error vocabulary unchanged.
- **Decision:**

### Native `z.toJSONSchema`, no third-party `zod-to-json-schema` — **PASS**

- No new third-party JSON schema package added. The orchestrator already calls `z.toJSONSchema(...)` at `orchestrator.ts:945, 957` for prompt-step schema export, untouched by sprint 47.
- **Decision:**

### ESM-only Node ≥20.10 — **PASS**

- All sprint-47 imports use `.js` extensions; no CJS shims added.
- **Decision:**

### Conventional Commits — **PASS**

- `git log --oneline -n 6` (sprint 47 commits): all six commits follow `<type>(<scope>): <subject>` — `feat(core)`, `fix(core)`, `test`. No `task_N` or `FLAG-N` identifiers in commit subjects or bodies.
- **Decision:**

### Zod v4 idioms — **PASS**

- All sprint-47 schema additions (`stepStateSchema.iter`, `awaitingInputSchema.loopStepId/loopIter`) use the existing `z.string().optional()` and `z.number().int().nonnegative().optional()` patterns. No `ZodSchema<T>` regressions; the project-wide `z.ZodType<T>` annotation on `RunStateSchema` and `stepStateSchema` is preserved.
- **Decision:**

---

## Other follow-ups (out of sprint-47 scope)

- The three pre-existing flaky tests carried over from sprint 46 — `[ABORT-001]`, `[ABORT-002]` in `tests/orchestrator/orchestrator.test.ts`, and the `state-save-failure` test — still fail with timeouts on the baseline. None were touched in sprint 47. Tracked under the existing flake-remediation effort.
- The pre-existing `§` references in `packages/cli/src/commands/resume.ts` and `packages/cli/src/paused-banner.ts` carry over from sprint 46 and remain unaddressed.
- The `BLOCK-1` from sprint 46 (run.ts paused outcome handling) appears resolved — `packages/cli/src/commands/run.ts:429-430` now branches on `result.status === 'paused'` and renders the paused banner. No new finding here; mentioned for completeness.
- The `stepId` schema in `packages/core/src/flow/schemas.ts:19` is permissive (any non-empty string). FLAG-2 proposes tightening it to reject `:`, which would also lock in handoff-id semantics and prevent exotic step-id authoring across the codebase. Worth a small standalone task in a future sprint.
- Sprint 47 introduced two new public StateMachine methods (`seedBodyStep`, `sweepBodySteps`) and one static (`bodyStepStateKey`). The `relay-monorepo` JSDoc table and any public API documentation should be regenerated before release, but no doc was claimed in this sprint's brief.
