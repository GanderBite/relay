# Sprint 49 · P1 — step-kind registry, error enrichment, graph splits, CLI shared data, config unification — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `68af454` (refactor(core): introduce lookupOrThrow, drop stepOrder, unify telemetry config)
- `904e145` (fix(core): typed FlowImportError and loop state machine refactor)
- `880eecb` (refactor: typed AbortReason and split exit-codes into errors/ submodules)
- `424e2a7` (refactor: split flow graph builder, dedup CLI step-data, log unmapped error codes)
- `fd9015c` (refactor: step-kind registry, shared CLI schemas, and CLI integration tests)

**Summary:** 0 BLOCK, 11 FLAG, 22 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Section A — Map utils + graph split (task_129, task_136)

### A.1 — `lookupOrThrow` invariant helper added and not exported from public index — **PASS**

- `packages/core/src/util/map-utils.ts:39-45` defines `lookupOrThrow<K, V>(map, key, invariantMsg)` that returns the value on hit and throws `Error('Invariant violated: ' + invariantMsg)` on miss. JSDoc documents the throw as the exception to the neverthrow discipline (invariant violations are bugs).
- `packages/core/src/index.ts` does not re-export `lookupOrThrow` — confirmed with a grep returning zero hits. The helper stays internal.
- The original `lookup(map, key) -> Result<V, ValueNotFoundError>` is unchanged at `map-utils.ts:24-30`.
- All 15 prior `lookup(...)._unsafeUnwrap()` call sites in graph.ts have been replaced; the new `graph/*.ts` files use `lookupOrThrow(...)` with concrete invariant messages quoted from each preceding comment (e.g. `'every \`key\` was inserted into \`stepMap\` by the caller'`).
- **Decision:**

### A.2 — `graph.ts` reduced to a re-export shim and split into nine sub-modules — **PASS** (with FLAG-1)

- `packages/core/src/flow/graph.ts:1-2` is the required two-line shim: `export { buildGraph } from './graph/compose.js'; export type { FlowGraph } from './types.js';`. All existing test imports from `flow/graph.js` continue to compile.
- Public `buildGraph` signature is preserved; `compose.ts:13-18` exports it as a thin wrapper that delegates to `buildGraphInternal(steps, start, false)`.
- The split adds two extra files beyond the seven listed targets — `graph/edges.ts` (118 lines) and `graph/producers.ts` (68 lines). Both are justified: edges.ts isolates the edge-walking logic that previously lived inline in `buildGraphInternal`, and producers.ts holds the shared `buildProducerMaps` consumed by both `ask-questions.ts` and `context-from.ts`. Without producers.ts the same logic would be duplicated across those two files.
- The `buildBodyGraph` function takes a `recurse` callback (`body.ts:13-19`) so `body.ts` does not import `compose.ts` directly — preventing a cycle since compose calls buildBodyGraph for every loop step. This is a clean dependency-injection pattern.
- **Decision:**

### A.3 — Several graph/ sub-modules exceed their listed line caps — **FLAG-1**

- **File:** `packages/core/src/flow/graph/cycle.ts` (122 / 120), `graph/roots.ts` (54 / 40), `graph/context-from.ts` (95 / 80), `graph/ask-questions.ts` (167 / 100), `graph/compose.ts` (157 / 150).
- **Spec:** Sprint brief task_136 listed each sub-module's line cap. `ask-questions.ts` is 67% over its 100-line cap.
- **Finding:** `cycle.ts` (122) and `compose.ts` (157) are within reasonable rounding (~2 and ~5 lines); the JSDoc on `traceCycle` and `kahnTopoSort` could not be meaningfully shortened without losing information. `roots.ts` (54) carries a fallback branch (the `entry === undefined` defensive path at lines 28-37) that pushes it above 40 lines — defensible because that branch is a real (if rare) invariant guard. `ask-questions.ts` is the outlier at 167 lines: it merges two validators (`validateAskQuestionSources`, `validateParallelAskQuota`) plus the recursive `collectLoopBodyAsks` helper. Splitting into `ask-questions.ts` (sources) and `ask-quota.ts` (quota) would put each at ~85 lines and align with the cap. `context-from.ts` at 95 (cap 80) is within ~20% — defensible.
- **Suggested fix:** Split `ask-questions.ts` into two files — `ask-question-sources.ts` (validateAskQuestionSources + the dotted-handoff loop-body helper, ~85 lines) and `parallel-ask-quota.ts` (validateParallelAskQuota + collectLoopBodyAsks, ~80 lines) — and update `compose.ts:6` to import from both. Leave `cycle.ts`, `roots.ts`, `context-from.ts`, and `compose.ts` as-is; their overruns are in the noise.
- **Decision:**. fix later. this is already an improvement good enough for me.

### A.4 — All sub-modules use `lookupOrThrow` consistently — **PASS**

- Every `lookupOrThrow(...)` call site in the new graph files supplies a concrete invariant string quoted from the original inline comment. Sample at `graph/compose.ts:91-95`: `lookupOrThrow(stepMap, key, 'every key in topoOrder was inserted into stepMap above')`.
- No `_unsafeUnwrap()` calls remain in any graph/ file (grep returns zero hits).
- **Decision:**

### A.5 — `buildEdges` and `buildProducerMaps` are clean abstractions — **PASS**

- `graph/edges.ts:17-118` walks every step's structural references (dependsOn, parallel branches/onAllComplete, onFail, script/branch onExit) and emits edges via an `addEdge` callback so the edge module never touches the successor/predecessor maps directly. This keeps the dependency direction one-way (compose owns the maps; edges only emits).
- `graph/producers.ts:31-68` factors out the shared `producers` and `loopBodyHandoffs` map construction used by both `ask-questions.ts` and `context-from.ts`. Without the extraction the same loop would appear twice.
- **Decision:**

---

## Section B — Error enrichment (task_130, task_131, task_134)

### B.1 — `FlowImportError` extends `FlowDefinitionError` with typed details — **PASS**

- `packages/core/src/errors.ts:125-133` declares `class FlowImportError extends FlowDefinitionError` with `details: { path: string; reason: 'missing-file' | 'missing-default-export' | 'build-not-run' }`. Code is `ERROR_CODES.FLOW_IMPORT`. The class is exported from `packages/core/src/index.ts`.
- `packages/cli/src/flow-loader.ts:147-198` distinguishes the three failure cases at the import call site: ENOENT-style errors → `'build-not-run'`; non-ENOENT errors → `'missing-file'`; default export missing or not Flow-shaped → `'missing-default-export'`.
- `packages/core/src/orchestrator/resume.ts:91-113` (`importFlow`) emits `FlowImportError` with `'build-not-run'` on import failure and `'missing-default-export'` when the candidate is not Flow-shaped.
- `packages/cli/src/errors/registry.ts:200-245` registers a handler for `ERROR_CODES.FLOW_IMPORT` mapping to `EXIT_CODES.definition_error` (exit 2) with a per-reason remediation message.
- **Decision:**

### B.2 — `FlowImportError`'s `'missing-file'` discriminant is mislabeled at the flow-loader call site — **FLAG-2**

- **File:** `packages/cli/src/flow-loader.ts:158-172`
- **Spec:** Brief task_130 named the three reasons but did not specify their semantics. Implicit constraint: the discriminant should describe what actually failed, not what the human guesses.
- **Finding:** At `flow-loader.ts:166-172` the implementation labels a non-ENOENT import failure (file exists but cannot be loaded — e.g. syntax error, missing dep, typescript compile error) as `reason: 'missing-file'`. That label suggests the file is absent, when in fact the file is present but unparseable. The ENOENT case (file actually absent) is labeled `'build-not-run'` (lines 158-164) — which is plausible only when the missing file is `dist/flow.js` specifically. A user with a typo'd path who hits ENOENT will see "build has not been run" guidance that is wrong for their case.
- The shared registry handler at `errors/registry.ts:234-242` falls through `'missing-file'` and `<unknown>` reasons to a "Flow file not found" message that says `${path} does not exist.` — directly contradicting the actual failure (file exists, import threw).
- **Suggested fix:** Either (a) rename the reasons to match the actual semantics — `'absent'`, `'unparseable'`, `'missing-default-export'` — or (b) keep the names but flip the labels: ENOENT → `'missing-file'`, non-ENOENT import failure → some new `'unparseable'`/`'load-failed'` reason. Option (b) requires updating the registry's per-reason format blocks and the resume.ts emission. Concrete sketch for (b):
  ```ts
  if (isModuleNotFound(detail)) {
    return err(
      new FlowImportError(`flow file not found at ${entryPath}`, {
        path: entryPath,
        reason: "missing-file",
      }),
    );
  }
  return err(
    new FlowImportError(`failed to import flow at ${entryPath}: ${detail}`, {
      path: entryPath,
      reason: "load-failed",
    }),
  );
  ```
  And update the `FlowImportDetails.reason` union plus the registry's `if/else if` branches accordingly.
- **Decision:** fix now. option (a)

### B.3 — `ERROR_CODES.FLOW_IMPORT` uses lowercase suffix while every other code uses uppercase — **FLAG-3**

- **File:** `packages/core/src/errors.ts:30`
- **Spec:** No formal convention, but `errors.ts:6-29` shows every prior code follows `relay_UPPERCASE` (`relay_ATOMIC_WRITE`, `relay_FLOW_DEFINITION`, `relay_HANDOFF_SCHEMA`, etc.).
- **Finding:** The new code is `FLOW_IMPORT: 'relay_flow_import_error'` — lowercase suffix with `_error` suffix. The brief task_130 wrote it that way verbatim, so the implementer matched the brief. The deviation from the existing 22 codes' convention is a minor inconsistency but propagates: `errors/registry.ts:125` aliases the code in its mapping comment as `relay_flow_import_error — mapped → exit 2 (definition_error) [alias for FLOW_IMPORT]`, hinting the implementer noticed.
- **Suggested fix:** Rename the literal to `'relay_FLOW_IMPORT'` to match the family, then update the registry comment line. The registry uses `ERROR_CODES.FLOW_IMPORT` so no other site needs editing.
- **Decision:** fix now.

### B.4 — `AbortReason` discriminated union exported from errors.ts and re-exported via index — **PASS**

- `packages/core/src/errors.ts:144-148` defines `AbortReason = { kind: 'signal'; signal: string } | { kind: 'sibling-failure'; stepId: string } | { kind: 'timeout' } | { kind: 'unknown' }`. JSDoc documents each variant.
- `packages/core/src/index.ts` re-exports `AbortReason` (and `packages/core/src/orchestrator/types.ts:9` mirrors it for the orchestrator surface).
- `RunResult.abortReason?: AbortReason | undefined` is added to the interface at `orchestrator.ts:189`. The brief said "RunResult.aborted gains reason: AbortReason" — the implementation chose a top-level optional `abortReason` field gated by `status === 'aborted'` instead of a nested `aborted: { reason }` object. Functionally equivalent, slightly different naming.
- **Decision:**

### B.5 — Only the `signal` and `unknown` AbortReason variants are ever produced; `sibling-failure` and `timeout` are dead-code variants — **FLAG-4**

- **File:** `packages/core/src/orchestrator/orchestrator.ts:341-348, 640-647, 437-451, 738-752`
- **Spec:** Brief task_131 said "the three abort sites in orchestrator.ts produce typed AbortReason values."
- **Finding:** A grep for `kind: 'sibling-failure'` and `kind: 'timeout'` across `packages/core/src` returns zero producer sites. Only `kind: 'signal'` (at the SIGINT/SIGTERM listeners, lines 343, 347 in `run()` and 642, 646 in `resume()`) and the `?? { kind: 'unknown' }` fallback on the log/result path are populated. The `runFailed = true` step-failure path at orchestrator.ts:1837 sets the run to `failed` without aborting, so `sibling-failure` is never reachable. A timeout path that aborts the run does not exist in this orchestrator. The two unused variants are still useful as a forward-compatible vocabulary, but the brief implied they would be wired.
- **Suggested fix:** Either (a) document on the union type that `'sibling-failure'` and `'timeout'` are reserved for future expansion (no consumer site exists today), or (b) add the producer sites: a `sibling-failure` reason at the parent abort caused by a fan-out branch failure (parallel.ts hosts the abort path that already runs Promise.all with abort-on-failure semantics), and a `timeout` reason if/when the orchestrator wires a top-level run timeout. (a) is the lower-cost option and accurately reflects current semantics.
- **Decision:** fix now. option (b)

### B.6 — `branchFailures.cause` accepts the documented `PipelineError | { code; message }` shape — **PASS**

- `packages/core/src/errors.ts:173-176`: `branchFailures?: Array<{ branch: string; cause: PipelineError | { code: string; message: string } }>`. The two-shape union is the documented backward-compatible shape.
- `packages/core/src/orchestrator/exec/parallel.ts:93-111` constructs the `cause` field per branch failure: `instanceof PipelineError` → carries the error verbatim; otherwise extracts `code` from a `{ code: string }`-shaped object or defaults to `'UNKNOWN'`, with `message` taken from the `Error.message` or `String(reason)`. The narrow type guard at lines 102-108 keeps the construction faithful to the schema.
- **Decision:**

### B.7 — `exitCodeFor` logs unmapped PipelineError codes to stderr before falling back — **PASS**

- `packages/cli/src/errors/format.ts:25-35`: when the registry has no entry for `err.code`, the function calls `console.error('relay: unmapped error code ' + err.code + ' — defaulting to exit 1')` before returning `EXIT_CODES.runner_failure`. Non-PipelineError errors fall through silently to the same exit code (no spurious log), as required by the brief.
- The mapping comment block at `errors/registry.ts:93-126` enumerates every relay-core ERROR_CODES entry with its mapped/unmapped status. Future additions to ERROR_CODES will be visible in this block.
- **Decision:**

### B.8 — Mapping comment block in registry.ts is informational only — no compile-time enforcement that the table stays in sync with ERROR_CODES — **FLAG-5**

- **File:** `packages/cli/src/errors/registry.ts:93-126`
- **Spec:** task_134 asked for a comment block "listing which ERROR_CODES entries from @ganderbite/relay-core are mapped." The block is present but is a bare comment.
- **Finding:** The 30-line comment block is a pre-rendered table of every relay-core error code and its target exit code. When the relay-core team adds a new code (e.g. `'relay_NEW_THING'`) the comment will silently go out of date — there is no test or build hook that fails when the table omits a code. The runtime fallback at format.ts:30 (`console.error('relay: unmapped error code ...')`) covers the surface so the user sees the gap, but the documentation drifts.
- **Suggested fix:** Add a unit test in `packages/cli/tests/errors/registry.test.ts` that imports `ERROR_CODES` from relay-core and asserts every code appears either in the registry Map (mapped) or in a hardcoded `KNOWN_UNMAPPED` set. The test fails when the relay-core team adds a code without classifying it. ~15 lines of test code, no production change required.
- **Decision:** fix now.

### B.9 — All exit codes carry the `'relay_'` prefix as required — **PASS**

- `packages/core/src/errors.ts:6-31`: every key under `ERROR_CODES` uses the `'relay_'` prefix (with the FLAG-3 case-style outlier).
- **Decision:**

---

## Section C — Registry + loop state machine (task_139, task_140)

### C.1 — `StepKindRegistry` and `defaultStepRegistry` introduced; `as never`/`as unknown` casts bounded to the registry seam — **PASS**

- `packages/core/src/orchestrator/step-kind-registry.ts:53-99` defines `class StepKindRegistry` with `register<K extends StepKind>(entry: StepKindEntry<K>): void`, `get<K extends StepKind>(kind: K): StepKindEntry<K> | undefined`, and `has(kind: StepKind): boolean`. The map storage erases the per-kind generic via two `as unknown as ...` casts (lines 73, 87). Each cast carries a comment explaining why TypeScript cannot follow the discriminant.
- The only consumer-side casts are at the dispatch sites: `orchestrator.ts:1320` (`step as never`) and `flow/define.ts:59` (`raw as never`). Both are commented and bounded — no `as never`/`as unknown` casts leak into the per-kind executor functions or into the StepKindEntry.execute/synthesize signatures.
- A grep for `as never\|as unknown` across the four files involved (orchestrator, define, step-kind-registry, step-registrations, step-dispatch-context) returns exactly four hits — the two registry-internal storage casts plus the two dispatch-site narrowing casts. No leakage into per-kind code.
- **Decision:**

### C.2 — Idempotent re-import via `has(kind)` guard in `registerBuiltInStepKinds` — **PASS**

- `packages/core/src/orchestrator/step-registrations.ts:25-26`: `if (registry.has('prompt')) return;` short-circuits the registration walk when the registry already carries the built-ins. JSDoc at lines 18-24 explains that this prevents a second import (e.g. from the orchestrator and from `defineFlow`'s side-effect import at `flow/define.ts:7`) from tripping the `register`-throws-on-duplicate guard.
- The `register(...)` method itself throws on duplicate (`step-kind-registry.ts:67`) so a third party who skips the side-effect import and calls `registerBuiltInStepKinds` directly will see the precondition error if they pass a non-default registry that has already been seeded.
- The line 26 guard is tested implicitly: both the orchestrator and define.ts side-effect-import the file, so any time a flow is defined and run, both paths execute and the second one short-circuits. No unit test exists for the `has` guard specifically.
- **Decision:**

### C.3 — `step-dispatch-context.ts` was added beyond the listed target_files — justified — **PASS**

- The brief listed only `step-kind-registry.ts`, `step-registrations.ts`, and edits to `define.ts`/`orchestrator.ts`. The implementer added a fourth file: `packages/core/src/orchestrator/step-dispatch-context.ts` (118 lines).
- `step-dispatch-context.ts:28-118` defines `interface StepDispatchContext` — the unified context bag passed to every registered executor's `execute(step, ctx)`. Defining this in `orchestrator.ts` would create a circular import (orchestrator → step-registrations → step-dispatch-context → orchestrator), which the JSDoc at lines 23-27 calls out explicitly. Defining it inside `step-kind-registry.ts` would couple the registry's pure type definitions to the heavyweight orchestrator-level field set.
- The new file is a clean type-only module: no runtime values, only one exported interface. The cross-file scope deviation is justified.
- **Decision:**

### C.4 — `LoopIterationStateMachine` has 7 states, not the 8 listed in the brief — **FLAG-6**

- **File:** `packages/core/src/orchestrator/exec/loop.ts:173-184`
- **Spec:** Brief task_140 listed `'idle' | 'iterating' | 'body-dispatching' | 'until-checking' | 'paused' | 'exhausted' | 'done' | 'aborted'` (8 states).
- **Finding:** The implementation defines `type LoopState` with 7 variants — `idle`, `iterating`, `body-dispatching`, `until-checking`, `exhausted`, `aborted`, `done`. The `paused` state from the brief is missing. The actual pause path bypasses the state machine entirely: `executeAsk` throws `AwaitingInputSignal`, which propagates up through `dispatch` (`runBodyStep` in orchestrator.ts) → `withRetry` → the for-loop's iteration → out of `executeLoop` to the orchestrator's `dispatchStep` catch, which calls `pauseStep` on the state machine layer (a different layer of state, the `StateMachine` in `state.ts`). The `LoopIterationStateMachine` never observes the pause; it simply unwinds because the `dispatch(...)` call rejected.
- The choice is defensible — collapsing pause into the propagation path keeps the loop state machine free of an exception-shaped transition — but it deviates from the brief's prescribed shape, and the `paused` state would be needed if a future feature lets the loop resume mid-iteration without unwinding (e.g. a non-blocking ask). The state-machine diagram comment at lines 161-172 also omits the pause edge for the same reason.
- **Suggested fix:** Either (a) add a sentence to the JSDoc at `loop.ts:186-196` noting that pause is observed at the `StateMachine` (state.ts) layer, not the iteration state machine, and that the brief's enumerated `paused` state is intentionally omitted because the iteration unwinds via exception propagation; or (b) add the `paused` variant for forward-compat and call `machine.pause()` from the catch in `runBodyStep` so the diagram closes. (a) preserves the smaller surface area.
- **Decision:**: fix now. option (b)

### C.5 — All 11 edge cases from the brief are preserved — **PASS**

- Initial iter: `loop.ts:435` (`startIter = ctx.getResumedIter?.() ?? 1`) and `machine.start(startIter)` at 436.
- Resume-start iter: `loop.ts:435` reads `getResumedIter` once; `machine.start` accepts the iter; `nextIter()` at 439 returns the seeded value.
- Body dispatch: `loop.ts:531` (`await ctx.dispatch(bodyStepId, bodyStep, iter)`), gated by the abort check at 464 and the skipped-on-resume short-circuit at 489.
- Body success: handoff promotion at 538-549, `machine.recordBodyStepSuccess(...)` at 551.
- Body ask-pause: handled by exception propagation; `dispatch` rejects with `AwaitingInputSignal`, the for loop unwinds, no transition is recorded by the iteration machine. Documented behaviour per the orchestrator's pauseStep path.
- Until evaluation: `loop.ts:566-590` reads `latestResult`, calls `untilSatisfied`, calls `machine.evaluateUntil(matched)`.
- Max-iter guard: `loop.ts:441-446` (`if (iter > maxIterations) machine.evaluateUntil(false); break;`) and the internal transition `iterating → exhausted` when `nextIter > maxIterations` at line 317.
- Iter increment: `evaluateUntil(false)` increments `next = this.#state.iter + 1` at line 316.
- Sibling sweep: still owned by `orchestrator.ts:1634-1668` (carried over from sprint 47) — the loop machine does not touch sibling state.
- Abort propagation: `loop.ts:448-450, 464-468, 556-558` set the machine to `aborted` at every observable boundary; `loop.ts:593-594` throws AbortError when terminal-aborted.
- Result assembly: `loop.ts:597-614` calls `readFinalBody` to materialise the body map from the recorded `lastIterationHandoffs`.
- **Decision:**

### C.6 — Loop state-machine illegal-transition errors throw raw `Error` — appropriate for invariant violations — **PASS**

- `loop.ts:222, 235, 240, 255, 270, 284, 304` throw `new Error('LoopIterationStateMachine.<method> called in state ${this.#state.kind}')`. These are programming-bug guards: a driver that dispatches body steps without `startIteration()`, or evaluates the until condition without `finishIteration()`, has a sequencing bug that should crash loudly. Consistent with the documented `lookupOrThrow` exception to neverthrow discipline.
- **Decision:**

### C.7 — `dispatchBodyStep`-style closures keep the registry executor signatures stable — **PASS**

- The brief constraint "the existing step executor function signatures must not change" is honored: every `executePrompt`, `executeScript`, `executeBranch`, `executeParallel`, `executeTerminal`, `executeLoop`, `executeAsk` retains its prior signature. The registry's `execute` adapter (`step-registrations.ts:31-198`) adapts the unified `StepDispatchContext` to each per-kind context shape via field-by-field projection, including conditional spreads (`...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {})`).
- **Decision:**

---

## Section D — CLI deduplication + config (task_132, task_133, task_135, task_137, task_138)

### D.1 — `Flow.stepOrder` removed; all callers migrated to `flow.graph.topoOrder` — **PASS**

- `packages/core/src/flow/types.ts` no longer carries a `stepOrder` field on the Flow interface (the prior line is gone, confirmed via the diff stat showing -1 line in types.ts).
- `packages/core/src/flow/define.ts` no longer assigns `stepOrder` (the prior `stepOrder: [...graph.topoOrder]` line is removed).
- A grep for `flow\.stepOrder` across packages/ returns zero hits — every caller has been migrated. CLI sites use `[...flow.graph.topoOrder]` when a mutable copy is required (e.g. `commands/run.ts:355`).
- `packages/core/src/orchestrator/resume.ts` and the rest of the orchestrator reach the topoOrder via `flow.graph.topoOrder`; no behavioural drift.
- **Decision:**

### D.2 — `exit-codes.ts` reduced to a 10-line re-export shim; logic split into `errors/{codes,registry,format,helpers}.ts` — **PASS** (with FLAG-7)

- `packages/cli/src/exit-codes.ts:1-10` re-exports `EXIT_CODES`, `ExitCode`, `exitCodeFor`, `formatError`, `errorRegistry`, `makeHandler`, `ErrorHandler`, `RegistryEntry` from the new errors/ submodules. Backward-compatible with every existing import site.
- `errors/codes.ts` (32 lines) holds only the `EXIT_CODES` constant and the `ExitCode` type; well within the 30-line cap modulo a header comment.
- `errors/format.ts` (92 lines) holds `exitCodeFor` and `formatError`; over the 80-line cap by 12 lines, but the overrun is two extra bullet sections of doc-comment in the file header. The dispatcher logic is roughly 30 lines.
- `errors/helpers.ts` (10 lines) holds `INDENT`, `BLANK`, `remediation` — added beyond the listed target_files, but justified because both `format.ts` and `registry.ts` need the same primitives and circular imports would otherwise force duplication.
- **Decision:**

### D.3 — `errors/registry.ts` is 477 lines, well above the 350-line cap — **FLAG-7**

- **File:** `packages/cli/src/errors/registry.ts`
- **Spec:** Brief task_133 said `registry.ts: ≤ 350 lines`.
- **Finding:** The file is 477 lines — 127 over the cap, ~36% over budget. The bulk is a single Map literal at lines 132-477 with one `[ERROR_CODES.X, makeHandler(...)]` entry per error class. The per-entry format closures average 25 lines apiece (one for the headline, one for the indented body, one or two for remediation lines). Without the cap the file is readable — each entry is self-contained — but the cap exists so the registry can't grow unboundedly. The 30-line ERROR_CODES mapping comment at lines 93-126 contributes to the line count but is not the main driver.
- **Suggested fix:** Extract the per-entry formatter functions (e.g. `formatStepFailure`, `formatFlowDefinition`, `formatTimeoutError`) into a sibling `errors/formatters.ts`, leaving `registry.ts` as just the Map literal that wires `ERROR_CODES.X` to `makeHandler(EXIT_CODES.X, guard, format-imported-from-formatters)`. After extraction, `registry.ts` should land around 200-250 lines and `formatters.ts` around 250-300 lines — both under 350.
- **Decision:** fix now.

### D.4 — `step-data.ts` extracted with shared `readStateSteps`, `readMetrics`, `buildSuccessStepRows`, `buildFailureStepRows` — **PASS**

- `packages/cli/src/step-data.ts:37-149` exposes the four required functions. `readStateSteps` and `readMetrics` swallow IO errors and return empty defaults — appropriate for banner display where a missing file is non-fatal. `buildSuccessStepRows` and `buildFailureStepRows` consume both readers and translate to the `SuccessStepRow`/`FailureStepRow` banner shapes.
- `packages/cli/src/commands/run.ts:355, 424` and `packages/cli/src/commands/resume.ts:459, 479` import the row-builders from `'../step-data.js'` — neither command file re-implements them inline. The duplicate implementation that previously lived in `resume.ts` is gone.
- One mild code smell at `step-data.ts:59`: `map.set(entry.stepId, entry as unknown as RawMetrics)`. The double cast is unnecessary — `parseResult.data` is already `z.infer<typeof RawMetrics>` so the entry is structurally `RawMetrics`. This is cosmetic — see FLAG-9.
- **Decision:**

### D.5 — Unnecessary double cast in `step-data.ts` — **FLAG-9**

- **File:** `packages/cli/src/step-data.ts:59`
- **Spec:** Code quality / typescript skill.
- **Finding:** `map.set(entry.stepId, entry as unknown as RawMetrics)` — the `as unknown as RawMetrics` is a no-op since `entry` is already typed via `z.infer<typeof RawMetricsArraySchema>` which narrows to `RawMetrics[]`. The double cast looks like a leftover from an earlier intermediate type that is no longer in scope.
- **Suggested fix:** Drop both casts:
  ```ts
  map.set(entry.stepId, entry);
  ```
  TypeScript will type-check `entry` as `RawMetrics` directly (verified mentally — `RawMetricsArraySchema.safeParse(...)` returns `data: RawMetrics[]`).
- **Decision:** fix now.

### D.6 — `normalizeArgvInput` extracted into `input-parser.ts` — **PASS**

- `packages/cli/src/input-parser.ts:277-320` exports `normalizeArgvInput(argv): { inputPrimary; inputExtras }` — the reshaping logic that previously lived inline in `commands/run.ts:195-231`. Behaviour is preserved: positional defaults to `'.'`, `--key value` becomes `"key=value"`, bare boolean becomes `"key=true"`.
- `packages/cli/src/commands/run.ts` no longer carries the inline reshaping (verified by the diff stat: -194 +10 in run.ts).
- **Decision:**

### D.7 — `schemas.ts` extracted with `RawStepStateSchema`, `RawMetricsSchema`, `LiveStatePartialSchema` — **PASS**

- `packages/cli/src/schemas.ts:17-54` exposes the three schemas. Each is a `z.object({...})` with `.optional()` modifiers on tail fields — consistent with Zod v4 patterns. The schemas are the partial-view shapes used by CLI file readers, intentionally narrower than the full state schemas in relay-core.
- `packages/cli/src/progress.ts:38` imports `LiveStatePartialSchema` from `'./schemas.js'`; the prior inline definition is removed (verified via the diff).
- `packages/cli/src/step-data.ts:13-17` imports `RawMetricsSchema`, `RawStepStateSchema` and re-uses them inside the local composite `RawStateJsonSchema`.
- **Decision:**

### D.8 — Telemetry config consolidated into settings.json under a `telemetry` key — **PASS** (with FLAG-8)

- `packages/core/src/settings/schema.ts:3-8`: `RelaySettings = z.object({ provider: z.string().min(1).optional(), telemetry: z.object({ enabled: z.boolean() }).optional() }).strict()`. The schema preserves `.strict()` and uses `.optional()` on both keys.
- `packages/cli/src/telemetry.ts:51-55`: `isEnabled` calls `await loadGlobalSettings()` and returns `false` on the err path — handles both Result variants per the brief.
- `packages/cli/src/telemetry.ts:1-86` no longer reads `~/.relay/config.json` — the prior `CONFIG_PATH` constant and `readFile`/`JSON.parse` block are gone, replaced by the `loadGlobalSettings()` call.
- **Decision:**

### D.9 — Telemetry function renamed from `isTelemetryEnabled` to `isEnabled` — **FLAG-8**

- **File:** `packages/cli/src/telemetry.ts:51`
- **Spec:** Brief task_135 said "isTelemetryEnabled reads from loadGlobalSettings().value?.telemetry?.enabled".
- **Finding:** The implementation renamed the exported function from `isTelemetryEnabled` to `isEnabled`. Inside the module the shorter name is fine, but other modules importing it now read `import { isEnabled } from '../telemetry.js'` which loses context — `isEnabled` for what? At a call site like `if (await isEnabled())` the meaning is unclear without jumping to the definition.
- A grep for `isEnabled` across packages/cli/src returns one consumer (the same module's `maybeSendRunEvent` at line 67), so the immediate blast radius is limited; the rename did not break callers because nobody else imported `isTelemetryEnabled` previously either.
- **Suggested fix:** Rename back to `isTelemetryEnabled` to match the brief and to stay self-documenting at import sites:
  ```ts
  export async function isTelemetryEnabled(): Promise<boolean> { ... }
  ```
  Update the local caller at `maybeSendRunEvent` line 67. ~3 lines of change.
- **Decision:** fix now.

### D.10 — All file writes go through atomic helpers; no fresh `fs.writeFile` paths added — **PASS**

- The new `step-data.ts` and `schemas.ts` are pure readers. The new `errors/*.ts` files do not write to disk. The new `step-kind-registry.ts`, `step-registrations.ts`, `step-dispatch-context.ts` are runtime-only modules. Telemetry's `maybeSendRunEvent` uses `fetch(...)` (network), not the filesystem — atomic write semantics do not apply.
- The atomic-write contract for `state.json`, `metrics.json`, etc. is unchanged — every existing call site still routes through `atomicWriteJson`.
- **Decision:**

---

## Section E — Integration tests (task_141)

### E.1 — `run-integration.test.ts` exercises the real Orchestrator with MockProvider — **PASS**

- `packages/cli/tests/commands/run-integration.test.ts:101-285` defines four tests (above the 3-test minimum from the brief): RUN-INT-001 (exit 0 on success), RUN-INT-002 (state.json records both steps as succeeded), RUN-INT-003 (buildSuccessStepRows returns correctly-shaped rows), RUN-INT-004 (non-zero exit code when a step has no configured response).
- The Orchestrator is NOT mocked — instead the `vi.mock('@ganderbite/relay-core', ...)` factory creates a `WrappedOrchestrator extends actual.Orchestrator` that injects the per-test `runDir` and `ProviderRegistry`. This is the right pattern for integration tests: the orchestrator's real run/dispatch/state code executes, only the CLI-layer wiring is stubbed.
- The `step-data.ts` helpers (`buildSuccessStepRows`, `readStateSteps`) are exercised end-to-end against state.json/metrics.json that the real orchestrator produced.
- Temp dirs are cleaned in `afterEach` via `rm(..., { recursive: true, force: true })`. No mock-Claude calls — MockProvider only.
- **Decision:**

### E.2 — `resume-integration.test.ts` covers the resume path with two phase-1/phase-2 tests — **PASS**

- `packages/cli/tests/commands/resume-integration.test.ts:284-392` defines two tests (meets the 2-test minimum): RESUME-INT-001 (resuming a failed run completes), RESUME-INT-002 (already-succeeded steps are not re-invoked).
- Each test runs phase-1 to deliberate failure (stepB unconfigured in MockProvider), then resumes with a different MockProvider whose responses include stepB. RESUME-INT-002 also asserts stepA was not re-invoked by counting MockProvider calls.
- The flow module is written to a temp dir using an absolute `pathToFileURL(...)` import of relay-core's compiled dist — a pragmatic workaround for the fact that bare specifiers cannot resolve from a temp directory outside any node_modules tree. Documented in the comment block at lines 117-121.
- The `WrappedOrchestrator` wrapper preserves test-supplied `providers` when `createOrchestrator({ providers })` passes them explicitly (so phase-1 uses its own registry), and falls back to the per-test `registryRef.current` when constructed without explicit providers (so resume picks up phase-2). The branching is at lines 50-53.
- **Decision:**

### E.3 — Mock typo `maybySendRunEvent` (sic) is harmless dead code — **FLAG-10**

- **File:** `packages/cli/tests/commands/run-integration.test.ts:94`, `resume-integration.test.ts:99`
- **Spec:** Code hygiene.
- **Finding:** Both test files define a sibling mock entry `maybySendRunEvent: vi.fn()` (typo of `maybeSendRunEvent`). The misspelled mock is never called by any production code — `telemetry.ts` exports `maybeSendRunEvent`, no `maybySendRunEvent`. Defensive over-mocking; no consumer means no test failure, but the typo lives on as cargo-cult code that future readers may copy without realising it does nothing.
- **Suggested fix:** Delete the `maybySendRunEvent: vi.fn()` line in both files. ~2 lines of change.
- **Decision:** fix now.

### E.4 — `process.exit` spied to capture the exit code without halting the test — **PASS**

- Both integration files install `vi.spyOn(process, 'exit').mockImplementation((code) => { capturedExitCode = ...; return undefined as never; })` so the test inspects the exit code without the test process itself terminating. The `as never` matches Node's `process.exit` signature (returns `never`); the explicit cast is the only sound way to satisfy the type checker.
- The success-path expectations match the runCommand contract — the command returns normally on success and only calls `process.exit` on error. RESUME-INT-001 asserts `capturedExitCode` is `undefined` (no exit call) on success.
- **Decision:**

### E.5 — Integration tests rely on extensive `vi.mock(...)` factories; refactoring brittleness is acceptable — **FLAG-11**

- **File:** `run-integration.test.ts:41-95`, `resume-integration.test.ts:41-100`
- **Spec:** Code quality / test maintainability.
- **Finding:** Each test file mocks roughly six modules: `@ganderbite/relay-core` (the wrap-and-extend pattern), `flow-loader.js`, `input-parser.js`, `banner.js`, `paused-banner.js`, `progress.js`, `telemetry.js`. The relay-core mock is non-trivial — it preserves every actual export then overrides `Orchestrator`, `registerDefaultProviders`, `loadGlobalSettings`, `loadFlowSettings`, `resolveProvider`. A future refactor that renames any of these or moves them between modules will silently break the mocks (vitest will not error on a mocked-but-no-longer-exported name).
- The pattern is established elsewhere in the CLI test suite, so the brittleness is consistent with the rest of the codebase. The benefit — drastic test isolation — is worth the cost. The risk is mostly a future-author footgun, not a current defect.
- **Suggested fix:** None for now. Worth a follow-up sprint to consider adopting a thin "test harness" helper that constructs the wrapped Orchestrator and the standard mock set in one call, so each new integration test does not re-derive the boilerplate. Defer.
- **Decision:**

---

## Project constraint verifications

### All fallible public functions return `Result<T, E>` via neverthrow — **PASS**

- `loadGlobalSettings` returns Result; `telemetry.isEnabled` correctly handles both arms (`packages/cli/src/telemetry.ts:53-54`).
- `buildGraph` returns `Result<FlowGraph, FlowDefinitionError>`; the new graph/ sub-modules each return Result-typed validators that are aggregated in `compose.ts`.
- `lookupOrThrow` is the documented exception (invariant violations are bugs, not domain errors); no other new throw site emits a domain error via raw throw.
- The `LoopIterationStateMachine` throws on illegal transitions — categorically invariant violations, consistent with the established lookupOrThrow exception.
- `errors.ts:884-906` `AwaitingInputSignal` is the existing control-flow signal exception; not widened in this sprint.
- **Decision:**

### No emojis in any output, code, or template — **PASS**

- A diff-only grep across sprint 49 changes returns zero emoji codepoints; the only matches were `✕`, `→`, `●─▶`, `○`, `·`, all from the SYMBOLS vocabulary.
- **Decision:**

### `simply` does not appear in any user-visible string — **MOSTLY PASS** (one comment-only occurrence)

- A diff-only grep returned a single hit at `packages/core/src/orchestrator/step-dispatch-context.ts:21` — `"by simply / declaring an interface"` inside a JSDoc comment that documents the StepDispatchContext design intent. The brand grammar bans `simply` in user-visible copy; code comments sit at the boundary. The comment never reaches a user-facing string. Worth flagging for tightness but not a defect — `relay-brand-grammar` distinguishes user-visible copy (CLI output, README, banners) from internal documentation.
- **Decision:**

### No trailing exclamation marks in user-visible copy — **PASS**

- A diff-only grep across sprint 49 changes returns zero trailing `!` characters in user-visible strings (CLI output, error messages, banners). `!` characters in `!==` and `!=` operators are not user-visible.
- **Decision:**

### Atomic writes for any file other processes might read — **PASS**

- No new file-write paths added in sprint 49. All file writes (state.json, metrics.json, batons/_, live/_) continue to route through `atomicWriteJson`. The new `step-data.ts` and `schemas.ts` are read-only; the new `errors/*.ts` and registry/dispatch files are runtime-only.
- **Decision:**

### Self-contained code comments — no spec refs, no sprint/task IDs — **PASS** (with carry-over)

- A diff-only grep for `§[0-9]\|task_[0-9]\|FLAG-[0-9]\|BLOCK-[0-9]` across sprint 49-changed lines returns zero hits.
- Pre-existing FLAG references in `packages/cli/src/progress.ts` (lines 549, 631, 643, 669, 792) predate sprint 49 — confirmed by `git diff 68af454^..fd9015c -- packages/cli/src/progress.ts` showing only the schema-import changes. These remain in the carry-over backlog.
- **Decision:**

### Domain-generic error names — **PASS**

- New `FlowImportError` is correctly named generic to the failure category (not provider-prefixed). `AbortReason` uses domain-generic kind names (`signal`, `sibling-failure`, `timeout`, `unknown`) without provider prefixes. `branchFailures.cause` uses the abstract `PipelineError | { code; message }` shape rather than a Claude-specific error.
- The pre-existing `ClaudeAuthError` is unchanged in this sprint and remains in the carry-over for the long-running rename effort.
- **Decision:**

### Native `z.toJSONSchema`, no third-party `zod-to-json-schema` — **PASS**

- No new third-party JSON schema package introduced. The new schemas in `cli/src/schemas.ts` use plain `z.object(...).safeParse()` — no `toJSONSchema` use here either, but the pre-existing call sites in `orchestrator.ts` and prompt-step compilation are untouched.
- **Decision:**

### ESM-only Node ≥20.10 — **PASS**

- All imports in the new files use `.js` extensions (e.g. `from '../zod.js'`, `from './graph/compose.js'`, `from '@ganderbite/relay-core'`). No CJS shims added. The file at `step-dispatch-context.ts:1-9` is type-only imports.
- **Decision:**

### Conventional Commits — **PASS**

- All five sprint-49 commits follow `<type>(<scope>): <subject>`: `refactor(core)`, `fix(core)`, `refactor` (no scope), `refactor` (no scope), `refactor` (no scope). No `task_N` or `FLAG-N` identifiers in the subjects or bodies.
- **Decision:**

### Zod v4 idioms — **PASS**

- `RelaySettings` schema uses `z.object({...}).strict()` and `.optional()` per Zod v4. The new CLI schemas use `z.object`, `z.enum`, `z.array`, `z.number().optional()`, `z.string().optional()` — all v4 idioms. No `ZodSchema<T>` regressions; the project-wide `z.ZodType<T>` annotations are preserved.
- **Decision:**

---

## Other follow-ups (out of sprint-49 scope)

- The pre-existing FLAG references in `packages/cli/src/progress.ts:549, 631, 643, 669, 792` carry over from earlier sprints and remain unaddressed by sprint 49. They reference internal flag IDs from the sprint-39/sprint-40 review cycle and should be either rewritten to be self-contained or stripped.
- The `ClaudeAuthError` rename (to `SubscriptionAuthError` per the domain-generic naming rule) was not in sprint 49's scope. Worth scheduling a focused refactor sprint that touches errors.ts, every consumer site, and the `claude-cli-provider`/`billing-safety` skill descriptions.
- The `unmapped error code` console.error fallback at `errors/format.ts:30` lights up only at runtime — there is no compile-time check that every relay-core code is registered. The pairing test suggested in FLAG-5 would close that gap. Worth a small standalone task.
- `cli/src/exit-codes.ts` is now a pure shim. Once every existing import site has been migrated to import directly from `cli/src/errors/*.js`, the shim could be removed altogether — but the migration is enough churn to defer to a clean-up sprint.
- The `LoopIterationStateMachine.paused` state from the brief is intentionally absent (FLAG-6). If a future feature requires non-unwinding pause (e.g. a streaming ask in a long-running loop), the `paused` variant will need to be added then. Worth documenting on the union type so the next implementer does not spend time re-deriving the design.
- The `relay-core` exit-code ↔ ERROR_CODES table in `errors/registry.ts:93-126` is currently a comment block. A unit test that walks `Object.values(ERROR_CODES)` and asserts each is either in the registry Map or in a `KNOWN_UNMAPPED` allowlist would lock the table in place against future relay-core code additions.
