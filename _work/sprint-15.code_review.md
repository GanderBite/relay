# Sprint 15 Code Review

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commit `a34cd7b` (feat(core): wave 0 — Race/Runner/Baton/RaceState lexicon rename), `89e435a` (wave 1), `379b857` (wave 2), `8b55948` (wave 3)
**Scope:** high-risk file set from task_128 (systems-engineer) plus supporting files — behavior-invariant verification of a pure rename refactor.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

## Invariant check (sprint brief)

1. `state.json` filename preserved — **PASS** (constant `STATE_FILENAME = 'state.json'` in `state.ts:18`; `loadState`, `RaceStateMachine.save`, and `#rebuildSucceededResult` all open by that name).
2. `runDir/batons/` replaces `runDir/handoffs/` — **PASS** (`batons.ts:100` `this.#batonsDir = join(runDir, 'batons')`; no lingering `handoffs/` directory literal in `packages/core/src/`).
3. `Artifact` not renamed — **PASS** (`runDir/artifacts/` still written in `exec/prompt.ts:397`; `artifacts` kept on `RunnerState` and `RunResult`).
4. `run`, `checkpoint`, `attempt`, `runId` preserved — **PASS** (`RunnerExecutionContext.attempt`, `RunnerExecutionContext.runId`, `RaceState.runId`, `RunResult.runId` all retained).
5. `contextFrom` preserved — **PASS** (`PromptRunnerSpec.contextFrom` in `race/types.ts:34`, consumed in `exec/prompt.ts:275`, validated in `race/graph.ts:349`).
6. Package names preserved — **PASS** (`@relay/core`, `@relay/cli`, `@relay/generator` — no scope changes in `packages/*/package.json`).
7. Orchestrator directory rename — **PASS** (`packages/core/src/orchestrator/` exists; no residual `packages/core/src/runner/` directory; imports resolve).
8. No backward-compat aliases — **PASS** (spot-checked `src/index.ts` — no re-exports of `Flow*`/`Step*`/`Handoff*` names).

Typecheck (`pnpm -F @relay/core typecheck`) and tests (`pnpm -F @relay/core test`, 329 tests in 41 files) both green.

---

## High-Risk Files

### packages/core/src/batons.ts

**Verdict:** PASS

- Path-traversal guards intact: `validateBatonId` (ID charset allowlist, rejects `/`, `\`, `..`, leading `.`, ASCII control chars) + `resolveBatonPath` (resolve + prefix check under `<runDir>/batons/`) are both still present and invoked from `write`, `read`, and `exists`.
- Write mutex via `#writeLocks` preserved verbatim from the pre-rename `HandoffStore` — same last-writer-wins + tail-replacement semantics.
- Error discriminants renamed consistently: `BatonSchemaError`, `BatonWriteError`, `BatonIoError`, `BatonNotFoundError`, all imported from the updated `errors.ts` and wired to `relay_BATON_*` codes.
- Constructor takes `runDir` and joins `'batons'` — honors the documented on-disk rename (invariant 2).
- No throw paths escape into caller code; all fallible ops return `Result<T, E>`.

### packages/core/src/state.ts

**Verdict:** FLAG (stale comments reference the old directory path)

- `STATE_FILENAME` is literally `'state.json'` and is joined into `runDir` in both `loadState` and `save()`. Resume-protocol filename invariant is honored.
- Every error class used (`RaceStateWriteError`, `RaceStateTransitionError`, `RaceStateCorruptError`, `RaceStateNotFoundError`, `RaceStateVersionMismatchError`) is renamed consistently; error codes under `relay_STATE_*` retained.
- `RaceStateSchema` and `stepStateSchema` Zod schemas mirror the `RaceState` / `RunnerState` shape; `batons` and `artifacts` fields persisted correctly; no field-name drift between schema and type.
- `RaceStateMachine` class exposes `startRunner` / `completeRunner` / `failRunner` / `skipRunner` / `resetRunner` — consistent Runner-flavored API. `#requireStep` / `#updateStep` are private and never cross the API boundary.
- Behavior unchanged: `markRun('failed'|'aborted')` still sweeps `running` → `failed` with timestamp and message; `resetRunner` still preserves `attempts` and drops terminal fields.
- Save serializer (`createWriteSerializer`) preserved — same monotonic-prefix durability contract.
- Inline cache `#runnerResults` preserved; docstring says "intentionally not serialized to state.json" which is correct and tracks with `RaceStateSchema` (no runner-results field).
- See FLAG-1 for the stale `flow/types.ts` path references in doc comments.

### packages/core/src/orchestrator/orchestrator.ts

**Verdict:** FLAG (internal method name `#writeFlowRef` leaks old noun; several doc comments still say "flow" / "per-flow")

- Class rename is correct: `Orchestrator` with `createOrchestrator` factory; no collision with the `Runner` concept (the runtime type `Runner` is a runner-spec union, `Orchestrator` is the DAG walker).
- `RunnerExecutionContext.runnerId` and `RunnerExecutionContext.runDir` / `raceName` / `raceDir` fields renamed per mapping table.
- Resume flow inspected: zombie-sweep (`running` → `failed`), failed→pending reset (`resetRunner`), re-dispatch via `seedReadyQueueForResume`, `#walkDag` shared entry — identical to pre-rename control flow.
- Abort wiring preserved: `RunAbortedError`, `raceAbort` helper, SIGINT/SIGTERM listeners, finally-block listener removal, `isAbortLike` discrimination.
- `raceStateMachine.save()` and `completeRunner`/`failRunner`/`startRunner` wiring intact; `RaceStateWriteError` propagated verbatim through `completions.error` check at line 1079.
- Parallel branch short-circuit preserved: `getBranchStatus` returns persisted status, `getBranchResult` returns cached in-memory result (line 869-874).
- `STATE_NOT_FOUND` code is still the error code the Orchestrator uses when the resume sidecar is missing — consistent with the old contract.
- See FLAG-2 for `#writeFlowRef` and BLOCK/FLAG notes below.

### packages/core/src/orchestrator/resume.ts

**Verdict:** PASS (with a caveat called out below: FLAG-5)

- Sidecar filename is `race-ref.json` (matches reviewer brief invariant). Reads/parses with a permissive Zod schema; `racePath` is `string | null | undefined` normalised to `null`.
- `loadRaceRef` returns `RaceStateNotFoundError` on ENOENT and `RaceStateCorruptError` on any other read or parse failure — same error taxonomy as `loadState`.
- `importRace` uses `pathToFileURL` (portable across Windows) and accepts `default` or named `race` export; typo-resistant via `isRace` runtime guard.
- `seedReadyQueueForResume` walks `race.graph.topoOrder`, checks predecessor statuses with the same `onFail === 'continue'` discriminator as the walker's `enqueueReady`. Logic matches the pre-rename version except for identifier renames.
- No behavior drift observed. The filename rename from `flow-ref.json` to `race-ref.json` is an intentional on-disk change documented in the reviewer brief; see FLAG-5 regarding sprint-description omission.

### packages/core/src/race/types.ts

**Verdict:** PASS

- Discriminated union `Runner = PromptRunner | ScriptRunner | BranchRunner | ParallelRunner | TerminalRunner` preserved with `kind` literal discriminants unchanged (`'prompt' | 'script' | 'branch' | 'parallel' | 'terminal'`).
- `PromptRunnerOutput` union shape preserved: `{ baton }`, `{ artifact }`, or `{ baton, artifact }` — field renamed from `handoff` to `baton` as required.
- `RaceSpec.runners: Record<string, Runner>` — matches the mapping-table rename of `FlowSpec.steps` → `RaceSpec.runners`.
- `RaceGraph` retains `successors`, `predecessors`, `topoOrder`, `rootRunners`, `entry` — `rootSteps` → `rootRunners` rename is consistent.
- `RunnerState.batons?: string[]` replaces the old `handoffs?: string[]` field on the same record.
- `RaceState` carries `raceName` / `raceVersion` / `runners` (not `flowName` / `flowVersion` / `steps`). Consistent with `RaceStateSchema` in `state.ts`.

### packages/core/src/race/graph.ts

**Verdict:** PASS

- Kahn topological sort preserved verbatim (same `inDegree` initialisation, same ready-queue sort, same cycle trace via DFS with `seenIndex`).
- Parallel-runner branch edges still synthesised (`addEdge(key, branch)` at line 95) so branches wait for the parent before dispatch — critical for avoiding double-billing.
- Self-branch guard preserved (line 76).
- `contextFrom` ancestor validation preserved: `validateContextFrom` still walks producers and requires an ancestor-writer for every required baton (name just changed from `handoff` to `baton`).
- `batonNameOf(runner)` reads `runner.output.baton` — matches the `PromptRunnerOutput` discriminant rename.
- Error messages use `runner` / `baton` terminology consistently. No residual `flow` or `handoff` references in the emitted strings.

### packages/core/src/orchestrator/exec/prompt.ts

**Verdict:** PASS

- `runner.output.baton` field-name handling: extracted via `'baton' in runner.output` narrowing at lines 366 and 289 — matches the renamed discriminant.
- `resolvePromptPath` path-traversal guard intact (absolute-path refusal + `resolve + prefix` check). Guard is byte-identical to the pre-rename version.
- `BatonSchemaError` is preserved as a dedicated discriminant through `wrapFailure`, so retry can distinguish baton-shape failures from provider/network failures.
- `BatonStore.write` invoked with `(batonKey, parsedJson.value, schema)`; writes land in `<runDir>/batons/<id>.json`.
- Artifact routing unchanged — `<runDir>/artifacts/<name>` still the destination, atomic write.
- Live-state writes still keyed by `runnerId`, so the CLI progress display stays aligned with the new terminology without further changes on that side.
- Cost metrics (`RunnerMetrics`) rename is end-to-end consistent with the CostTracker call at line 420.

### packages/core/src/index.ts

**Verdict:** PASS

- No old names leak through the public API. `Runner`, `Race`, `RaceSpec`, `RaceState`, `RaceStatus`, `RunnerState`, `RunnerStatus`, `RunnerKind`, `PromptRunnerSpec`, `ScriptRunnerSpec`, `BranchRunnerSpec`, `ParallelRunnerSpec`, `TerminalRunnerSpec`, `BatonStore`, `BatonIoError`, `BatonNotFoundError`, `BatonSchemaError`, `BatonWriteError`, `RaceStateCorruptError`, `RaceStateNotFoundError`, `RaceStateTransitionError`, `RaceStateVersionMismatchError`, `RaceStateWriteError`, `RaceStateMachine`, `Orchestrator`, `createOrchestrator`, `OrchestratorOptions`, `RunOptions`, `RunResult`, `RunnerExecutionContext`, `RunnerResult`, `defineRace`, `runner`, `loadBatonValues` — all present, all with the new names.
- No alias exports for `Flow*` / `Step*` / `Handoff*` / `StateMachine` / `RunState` — clean break as specified.
- `StepFailureError` is still exported (see FLAG-3).
- Comment at line 11 still says `defineRace, runner.*, atomicWrite*` which is on-brand.

### packages/core/src/errors.ts

**Verdict:** FLAG (see FLAG-3, FLAG-4)

- Every renamed error class present with matching code constant:
  - `RaceDefinitionError` → `relay_RACE_DEFINITION`
  - `BatonIoError` / `BatonNotFoundError` / `BatonSchemaError` / `BatonWriteError` → `relay_BATON_*`
  - `RaceStateCorruptError` / `RaceStateNotFoundError` / `RaceStateTransitionError` / `RaceStateVersionMismatchError` / `RaceStateWriteError` → `relay_STATE_*`
- `BatonSchemaError.batonId` (renamed from `handoffId`); `RaceStateTransitionError.runnerId` (renamed from `stepId`); `RaceStateVersionMismatchError.expected/actual` carry `{ raceName, raceVersion }` fields. Consistent with the mapping table.
- `toRaceDefError` renamed from `toFlowDefError`; used from `race/define.ts` and `orchestrator/orchestrator.ts`.
- `StepFailureError` class name, error-code constant `relay_STEP_FAILURE`, and public instance field `.runnerId` — see FLAG-3.
- `ProviderCapabilityError` doc comment still says "Thrown at flow-load time when a step requests..." — see FLAG-4.

---

## BLOCK · 0

(none)

---

## FLAG · 5

### FLAG-1 · Stale doc-comment references to `flow/types.ts`

- **File:** `packages/core/src/state.ts:24-37`, `packages/core/src/state.ts:343`, `packages/core/src/state.ts:357`, `packages/core/src/state.ts:447`
- **Spec:** Sprint-15 description: directory `flow/` → `race/`. Stale paths in doc comments can mislead future readers doing grep archaeology.
- **Finding:** The two Zod-schema blocks in `state.ts` (lines 24 and 37) carry comments that read:
  > Schema mirrors RunnerState from flow/types.ts.
  > Schema mirrors RaceState from flow/types.ts.

  The actual path is `packages/core/src/race/types.ts`. Line 343 of the same file says "Use loadAndVerify when flow-compat is required" (should be "race-compat"). Line 357 says "the run was written by a different flow or version" (should be "race"). Line 447 similarly mentions "different flow."

  Non-functional — these are doc comments and don't affect typecheck or runtime behavior — but they contradict the sprint's vocabulary-refresh mandate and will confuse anyone grepping the codebase for `flow/types.ts`.
- **Suggested fix:** Replace each occurrence. For lines 24 / 37:
  ```
  // Schema mirrors RunnerState from race/types.ts. The explicit z.ZodType<RunnerState>
  // annotation forces a compile-time equivalence check — if race/types.ts adds a
  // required field, this line fails typecheck.
  ```
  Update line 343 to "Thin wrapper over loadState. Use loadAndVerify when race-compat is required." Update lines 357 and 447 to say "written by a different race" instead of "different flow."
- **Decision:**

### FLAG-2 · Private method `#writeFlowRef` in Orchestrator

- **File:** `packages/core/src/orchestrator/orchestrator.ts:202`, `packages/core/src/orchestrator/orchestrator.ts:608`
- **Spec:** Sprint-15 mapping: every identifier renamed except the documented stays. `writeFlowRef` is not on the stays list.
- **Finding:** The Orchestrator has a private method `#writeFlowRef` (declared at line 608, called at line 202) that writes the new `race-ref.json` sidecar. The method name still carries the old "flow" noun despite writing the race-ref payload. Method is private, so no API compatibility impact, but it's a rename miss and makes the symbol inconsistent with everything around it (`RACE_REF_FILENAME`, `loadRaceRef`, `importRace`).
- **Suggested fix:** Rename to `#writeRaceRef`. Two edits:
  - line 202: `await this.#writeFlowRef(runDir, race, opts.racePath);` → `await this.#writeRaceRef(runDir, race, opts.racePath);`
  - line 608: `async #writeFlowRef<TInput>(` → `async #writeRaceRef<TInput>(`
- **Decision:**

### FLAG-3 · `StepFailureError` not renamed to `RunnerFailureError`

- **File:** `packages/core/src/errors.ts:77-90`, `packages/core/src/index.ts:47`, every `throw new StepFailureError(...)` site (`orchestrator/exec/prompt.ts:234`, `orchestrator/exec/script.ts:35`, `orchestrator/exec/branch.ts:30`, `orchestrator/exec/parallel.ts:102`)
- **Spec:** Sprint-15 mapping table says `Step` → `Runner` systematically. The handoff-related errors received the rename (`HandoffSchemaError` → `BatonSchemaError`, etc.). The state-related errors received the rename (`StateTransitionError` → `RaceStateTransitionError`). `StepFailureError` is the last `Step`-prefixed identifier in the error hierarchy and was not renamed. Its error code (`ERROR_CODES.STEP_FAILURE = 'relay_STEP_FAILURE'`) also retains the old noun.

  The sprint description's explicit enumeration mapping does not call out `StepFailureError` by name, but it also says:

  > Rename class and type identifiers, export names, field names, method names, directory names, file names where they carry the old concept.

  And:

  > Runner types that aggregate the others
  > ...
  > `Step` / `StepSpec` / `StepKind` / `StepStatus` / `StepState` (all discriminants: prompt, script, branch, parallel, terminal) → `Runner` / `RunnerSpec` / `RunnerKind` / `RunnerStatus` / `RunnerState`

  `StepFailureError` carries the old concept — it's thrown when a runner (formerly a step) fails. Its public `.runnerId` field is already renamed, but the class name is not. This is a rename inconsistency, not a functional bug.

- **Finding:** `StepFailureError` class name, `ERROR_CODES.STEP_FAILURE`, and the wire string `relay_STEP_FAILURE` all still carry "Step". CLI exit-code mapping and external tests that discriminate on this name would need to be migrated at the same time. Could be argued to be out of scope ("not explicitly mapped") but it's the only "Step"-prefixed identifier that survives, which reads as an oversight rather than a deliberate stay.
- **Suggested fix:** Decide whether this falls in scope.
  - If yes: rename `StepFailureError` → `RunnerFailureError`, `ERROR_CODES.STEP_FAILURE` → `ERROR_CODES.RUNNER_FAILURE` (with wire string `relay_RUNNER_FAILURE`), update the four `throw new StepFailureError(...)` sites and the re-export in `index.ts`. Check that the CLI's exit-code mapper keys off the same constant (not a literal string).
  - If no: add a one-line comment at `errors.ts:77` documenting the deliberate stay ("kept as `StepFailureError` because the §8.2 exit-code mapping is keyed by this name — rename requires a coordinated CLI amendment"), so future reviewers don't file this again.
- **Decision:**

### FLAG-4 · Stale "flow" / "step" terminology in doc comments across core

- **File:** `packages/core/src/errors.ts:443`, `packages/core/src/orchestrator/orchestrator.ts:36,61,83,105,202 (see also FLAG-2),577,886`, `packages/core/src/orchestrator/exec/script.ts:16`, `packages/core/src/orchestrator/exec/branch.ts:13`, `packages/core/src/providers/types.ts:9,24,140,261`, `packages/core/src/providers/claude/provider.ts:65`, `packages/core/src/providers/claude-cli/provider.ts:61`, `packages/core/src/race/schemas.ts:49`, `packages/core/src/race/define.ts:56,70,77`, `packages/core/src/race/runners/*.ts` (all five "step builders are load-time programmer-error" comments), `packages/core/src/race/types.ts:6-12,69`
- **Spec:** Sprint-15 scope: "rename every identifier in `packages/core/src/` and `packages/core/tests/` per the mapping table." Doc comments that speak of "flow-load time," "step builders," "per-flow settings," "promptStep(...)" belong to the old vocabulary.
- **Finding:** Dozens of residual references in JSDoc and inline comments. Specific callouts:
  - `errors.ts:443` — "Thrown at flow-load time when a step requests a capability..." (should be "race-load time when a runner requests").
  - `orchestrator.ts:36` — "Mirrors the default in flow/schemas.ts" — path wrong (it's `race/schemas.ts`).
  - `orchestrator.ts:886` — "when authors run their flow through promptStep(...)" — wrong factory name (it's `runner.prompt(...)`), wrong noun.
  - `orchestrator.ts:61, 83, 105, 577` — "per-flow settings" should be "per-race settings."
  - `orchestrator.ts:100-101, 544` — "per-step executor"/"per-step ctx"/"per-step token counts" should be "per-runner."
  - `race/define.ts:56` — "step ids. This is load-time programmer-error validation — flows that fail" (step ids → runner ids, flows → races).
  - `race/define.ts:70` — error message says `defineRace({ runners: { "${key}": <step>, ... } })` where `<step>` is a placeholder for a runner. Borderline — placeholders carry semantic weight, so this could be user-facing error text.
  - `race/runners/*.ts` — five "step builders are load-time programmer-error" lines (one per runner kind).
  - `race/schemas.ts:49` — "also applies the same fallback at dispatch time so flows that bypass this" (should be "races that bypass this").
  - `race/types.ts:6,12,69` — "every step type," "the step's stable identifier," "Specification for a step that fans out to multiple named sub-steps" all still reference "step."
  - `providers/types.ts:9,24,140,261` — four callouts: "flow authors," "flow-load time," "flow/step identity," "used in flow definitions."
  - `providers/claude/provider.ts:65`, `providers/claude-cli/provider.ts:61` — "run at flow-load time."
  - `orchestrator/exec/script.ts:16`, `orchestrator/exec/branch.ts:13` — `step?: unknown` optional field on `ScriptExecContext` / `BranchExecContext`. Dead code (never read, never written), relic of an earlier API. See FLAG-6.

  None of these affect typecheck, test behavior, or runtime output. They are pure vocabulary drift. But task_128's explicit brief is "open the mapping table, do one concept at a time in dependency order," and leaving this many "flow"/"step" comments behind is the exact debt the sprint set out to erase.
- **Suggested fix:** Do a targeted sweep: for each file listed, replace "flow" → "race", "step" → "runner", "step ids" → "runner ids", "per-flow" → "per-race", "flow-load time" → "race-load time," "flow authors" → "race authors," "promptStep" → "runner.prompt," "step builders" → "runner builders" in comments only (not in strings that might be user-facing — treat `race/define.ts:70`'s error message as a borderline case and decide whether to touch it).
- **Decision:**

### FLAG-5 · Sidecar filename rename `flow-ref.json` → `race-ref.json` is not called out in the sprint description

- **File:** `packages/core/src/orchestrator/resume.ts:17`, `packages/core/src/orchestrator/orchestrator.ts:46`
- **Spec:** Sprint-15 description: "`state.json` file name stays (the TYPE is renamed, but the on-disk filename is preserved so sprint-13's checkpoint / resume protocol keeps working without a data migration)."
- **Finding:** The sprint description explicitly documents one on-disk change (`handoffs/` → `batons/`) and one explicit stay (`state.json`). The sidecar file that the resume protocol reads has been renamed from `flow-ref.json` (sprint-5, task_41, commit `fae1ef14`) to `race-ref.json`. This rename is NOT mentioned in the sprint description's "WHAT STAYS" list, but the reviewer brief does explicitly name the new file as `race-ref.json` ("check the resume file is now `race-ref.json` and the protocol works"), which resolves the ambiguity in the rename's favor.

  The rename is internally consistent — `loadRaceRef`, `#writeFlowRef` (see FLAG-2), `RaceRef` interface, `RACE_REF_FILENAME` constant all agree.

  The risk is: an existing run directory written by the pre-rename Orchestrator has a `flow-ref.json` but the post-rename Orchestrator looks for `race-ref.json`. Resume against such a directory will return `RaceStateNotFoundError('race-ref.json not found')` → `PipelineError(STATE_NOT_FOUND, ...)` with a message that will confuse users whose prior run succeeded under sprint-14. Because the sprint explicitly calls out "no backward-compat aliases — clean break (pre-production)," this is accepted as intentional breakage. Worth recording so future users (or readme authors) understand the migration story.
- **Suggested fix:** Three options:
  - **Wont fix** if pre-production breakage is accepted; document in sprint-15 acceptance notes that in-flight runs from sprint-14 are no longer resumable and must be re-run from scratch.
  - **Fix later** by adding a one-time migration path in resume: on ENOENT for `race-ref.json`, fall back to reading `flow-ref.json` and remapping `flowName`/`flowVersion`/`flowPath` fields to the new schema. Carries its own risks (drifting schema surface, false confidence that the old run is still valid after the broader Race/Runner type rename).
  - **Fix now** by amending the sprint description (task_128's text) to name the `flow-ref.json` → `race-ref.json` rename explicitly, so the on-disk contract is fully documented.
- **Decision:**

---

## PASS · 8 (no action needed)

- `packages/core/src/batons.ts`: Path-traversal guards (`validateBatonId`, `resolveBatonPath`), write mutex, and error taxonomy (`BatonSchemaError`/`BatonWriteError`/`BatonIoError`/`BatonNotFoundError`) all renamed cleanly with no behavior change.
- `packages/core/src/state.ts`: `state.json` filename preserved verbatim; `RaceStateMachine` transitions, save serializer, zombie sweep, and version-verify logic unchanged except for identifier renames. (FLAG-1 catches the stale comment paths.)
- `packages/core/src/orchestrator/orchestrator.ts`: Resume flow, abort wiring, retry budget, parallel short-circuit, and `RaceStateWriteError` propagation all preserved. (FLAG-2 and FLAG-4 catch the vocabulary drift in comments and the private method name.)
- `packages/core/src/orchestrator/resume.ts`: `loadRaceRef` error taxonomy matches `loadState`; `importRace` portable across platforms; `seedReadyQueueForResume` predecessor check matches the walker's `enqueueReady`.
- `packages/core/src/race/types.ts`: Discriminated union integrity preserved; `PromptRunnerOutput` union renamed `handoff` → `baton` consistently; `RaceSpec`/`RaceGraph`/`RaceState`/`RunnerState` all carry the new field names.
- `packages/core/src/race/graph.ts`: Kahn topo sort, parallel-branch synthetic edges, self-branch guard, and `contextFrom` ancestor validation all preserved. Error strings use the new vocabulary throughout.
- `packages/core/src/orchestrator/exec/prompt.ts`: `runner.output.baton` narrowing correct; `resolvePromptPath` guard intact; `BatonStore.write` signature honored; `BatonSchemaError` discriminated through `wrapFailure`.
- `packages/core/src/index.ts`: Public surface is clean; no `Flow*`/`Step*`/`Handoff*` names leak; no alias exports.

---

## Other follow-ups (out of sprint-15 scope)

- **FLAG-6 (dead-code relic):** `ScriptExecContext.step?: unknown` (`exec/script.ts:16`) and `BranchExecContext.step?: unknown` (`exec/branch.ts:13`) are unused optional fields (never read, never written). They predate this sprint. Belongs to a separate dead-code cleanup task, not sprint-15's lexicon mandate. Recommend removing in a follow-up wave.
- **Duplicated `RACE_REF_FILENAME` constant** (`orchestrator.ts:46` and `resume.ts:17`): pre-existing duplication (the old `FLOW_REF_FILENAME` was duplicated too). Move to a shared `constants.ts` in a future refactor.
- **`BranchRunnerResult` / `ScriptRunnerResult` lack `kind` discriminators** (`orchestrator/types.ts:11` notes this is intentional — "they predate this union"). Not in sprint-15 scope but could be revisited for a uniform `RunnerResult` union in a future sprint.
- **Typecheck is clean and 329 tests pass** on the renamed surface, so the rename is functionally sound even though FLAG-1 / FLAG-4 show vocabulary drift in doc comments.

**Summary: 0 BLOCK, 5 FLAG, 8 PASS.**
