# Sprint 2 · Flow DSL — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits `4f1ee1b` → `1653164` (retroactive — current on-disk state after sprint 4 follow-ups).
**Summary:** 1 BLOCK, 13 FLAG, 11 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## BLOCK · 1

### BLOCK-1 · `promptOutputSchema` permits `{ artifact, schema }` which the TS discriminated union rejects

- **File:** `packages/core/src/flow/schemas.ts:21-29`
- **Spec:** tech spec §4.4.1 — `PromptStepOutput = { handoff: string; schema?: ZodSchema } | { artifact: string } | { handoff: string; artifact: string; schema?: ZodSchema }`
- **Finding:** The Zod validator is a `strictObject` with `handoff`, `artifact`, and `schema` all independently optional, gated only by a refinement that "at least one of handoff or artifact is set." That admits `{ artifact: 'report.html', schema: MySchema }` — a shape the spec table explicitly does not enumerate and the TS type `PromptStepOutput` (packages/core/src/flow/types.ts:13-16) rejects at the type level. Result: `step.prompt({ output: { artifact: 'x', schema } })` fails TypeScript compilation but passes runtime validation, so any dynamic call path (JSON-driven tests, generated flows) silently accepts an off-spec shape. Downstream the schema is never consulted for artifact-only outputs, so the caller's intent is silently discarded.
- **Suggested fix:** Replace the single strictObject + refine with `z.discriminatedUnion` or three explicit `z.strictObject` variants joined by `z.union(...)`. The error message should name which of the three shapes the input came closest to. Mirrors the TS type exactly.
- **Decision:**

---

## FLAG · 13

### FLAG-1 · Kahn's topo sort uses sorted-array insertion — O(V²) worst case, not O(V+E)

- **File:** `packages/core/src/flow/graph.ts:140-156`, `insertSorted` at `167-177`
- **Spec:** tech spec §4.8.1 (DAG + cycle detection + topological sort); task_17 description specifies Kahn's algorithm (no complexity guarantee, but Kahn's canonical complexity is O(V+E)).
- **Finding:** `ready.shift()` is O(V), and every successor whose in-degree drops to zero is inserted via `insertSorted` (binary-search + `Array.splice`) which is O(V) per insert. For a wide graph (many steps becoming ready at once) this degrades to O(V²). Sprint-2 flows are tiny so this never matters in practice, but it is a latent footgun if any future sprint introduces synthetic fan-out (generator-produced flows, compaction). The sort-for-determinism intent could be preserved with a priority queue or by sorting the final order once at the end of Kahn's.
- **Suggested fix:** Either accept the suboptimal complexity (flows will never exceed ~50 steps) and add a `// ordering is deterministic via sorted insertion` comment, or switch to a simple heap. Not urgent.
- **Decision:** fix later. for now it's hard to judge what will be the average steps in a flows. From my expirence there is at most 10 steps for complex flows. We don't have to fix something that is not bottleneck just yet.

### FLAG-2 · `validateContextFrom` calls `collectAncestors` once per step — O(V\*(V+E))

- **File:** `packages/core/src/flow/graph.ts:258-311` (caller) and `313-334` (callee)
- **Spec:** tech spec §4.8.1 (validation contract); task_17 specifies this check but no complexity bound.
- **Finding:** For every step with `contextFrom`, `collectAncestors` walks the predecessor graph from scratch. No memoization between calls. In a 50-node flow where half the steps use `contextFrom`, this is measurable. Fix: compute reverse-reachability once in topological order (each step's ancestor set is the union of its immediate predecessors' ancestor sets ∪ the predecessors themselves) — a single linear pass.
- **Suggested fix:** Memoize ancestor sets on the topo-order walk. Simple, local change; halves the graph's asymptotic complexity for the contextFrom check.
- **Decision:**: fix now. Let's do it. Library must also be a state machine so it should save things in memory for quicker executions in later steps.

### FLAG-3 · `branchStepSpecSchema` accepts stray `output` field silently

- **File:** `packages/core/src/flow/schemas.ts:52-60`
- **Spec:** tech spec §4.4.3 — `BranchStepSpec = Omit<ScriptStepSpec, 'output'> & { onExit: Record<string, string> }`. The `Omit` is explicit: branch steps have no `output`.
- **Finding:** `branchStepSpecSchema` is a regular `z.object` (not `z.strictObject`). If a user copy-pastes a script spec and just renames it, a stray `output: { artifact: 'foo.txt' }` is silently accepted and then silently dropped (never reaches `BranchStep`). Spec §4.4.3 and task_14 explicitly require "No `output` allowed (enforce at type + runtime)." TS type enforces; runtime schema does not.
- **Suggested fix:** Convert to `z.strictObject` or add a `.refine((s) => !('output' in s), ...)` clause. Same pattern applies to `scriptStepSpecSchema`, `parallelStepSpecSchema`, `terminalStepSpecSchema`, `promptStepSpecSchema` — none are strict, so any typo in a field name is silently accepted. Recommend strict across the board.
- **Decision:**: fix now - convert to z.strictObject

### FLAG-4 · `mustGet` throws — violates the @relay/core no-bare-throw boundary rule

- **File:** `packages/core/src/util/map-utils.ts:1-6`; used extensively from `packages/core/src/flow/graph.ts`
- **Spec:** project boundary rule (adopted sprint 4) — "No bare `throw` inside `@relay/core/**`." The exception for `schema.parse` is Zod-originated; anything the code itself originates must be Result-based.
- **Finding:** `mustGet(map, key)` throws a plain `Error` when a key is absent. All current call sites in `graph.ts` are invariant assertions (`mustGet(successors, key)` where `key` came from `Object.keys(steps)`), so the throw path is unreachable in practice — but the function signature itself promises the throw, and a future caller passing a user-controlled key would bubble a plain `Error` (not a `FlowDefinitionError`) past the Result boundary. Either way, this is the only bare `throw` in the sprint-2 Flow DSL surface.
- **Suggested fix:** Two options: (a) keep `mustGet` but make it return `Result<V, Error>` and force callers to `_unsafeUnwrap()` at assertion sites (ugly); (b) replace with `map.get(key) ?? invariant('reason')` where `invariant` is a dev-only assertion that throws a `PipelineError` subclass the CLI can map. Minimum viable: rename to `invariantGet` and throw `PipelineError` so the type at least conforms to the hierarchy.
- **Decision:**: It should return Result<V, ValueNotFound> where ValueNotFound is a custom error specific for mustGet

### FLAG-5 · `PromptStep.id = ''` leaks a synthetic empty id when users compose builder output directly

- **File:** `packages/core/src/flow/steps/prompt.ts:13`, same pattern in `script.ts:12`, `branch.ts:12`, `parallel.ts:12`, `terminal.ts:12`
- **Spec:** task_11 — "`StepBase` (id added by flow compiler)."
- **Finding:** The builders set `id: ''` as a placeholder that `defineFlow` later overwrites (`define.ts:33`). If a user destructures or inspects the builder result outside `defineFlow` (tests, custom flow compilers, the future registry), they see `id: ''` — a sentinel that is neither the spec-defined id nor a documented placeholder. The types also expose `id: string` as a required field on every `Step` union member, so `step.prompt({...})` returns a `Step` that lies about its id until `defineFlow` fixes it.
- **Suggested fix:** Remove `id` from the builder return type; have the builder return `Omit<PromptStep, 'id'>` (a `PromptStepInternal` type) and let `defineFlow` synthesize the full `PromptStep`. The public `Step` discriminated union keeps `id: string` and is only observable on the compiled `Flow.steps` map.
- **Decision:** fix now - suggested fix is correct

### FLAG-6 · `FlowGraph.successors` / `predecessors` are typed `ReadonlyMap` but the underlying `Map` is not frozen

- **File:** `packages/core/src/flow/graph.ts:114-127`, `packages/core/src/flow/types.ts:59-65`
- **Spec:** §4.9 step 4 (runner relies on the graph); no explicit immutability claim, but `defineFlow` calls `Object.freeze` on the outer `Flow` object (`define.ts:37`) signaling intent.
- **Finding:** `Object.freeze(Flow)` freezes the top-level object but the nested `Map`s inside `graph.successors` and `graph.predecessors` remain mutable at runtime — a consumer can `flow.graph.successors.get('x').add('y')` and the type system never complains because the outer ReadonlyMap only masks the map's mutators, not the ReadonlySet's. Current consumers don't mutate, but nothing enforces it.
- **Suggested fix:** Either wrap in a true readonly `Map` shim (`Object.freeze` does not work on Maps) or document that the ReadonlyMap typing is aspirational. A cheap route: swap to `Record<string, readonly string[]>` for the on-disk shape (still deterministic, trivially serializable, actually immutable in TypeScript's view).
- **Decision:**: fix later, ReadonlyMap type is aspirational for developers to see.

### FLAG-7 · Error messages do not name remediation commands — product-voice drift

- **File:** `packages/core/src/flow/graph.ts:50, 59-62, 66-69, 75-78, 89-94, 287-290, 301-305`; `packages/core/src/flow/define.ts:17, 28-30`
- **Spec:** product spec §4.2 "Copy rules — Every error message names the specific file/line/command that caused it, then names the exact command to try next."
- **Finding:** Flow-definition errors name what is wrong (`step "x" depends on unknown step "y"`) but never name the next action. A first-time user facing "flow has multiple root steps (a, b) — set `start:` to pick one" has to translate the message to code. Product §4.2 specifies remediation language: "`set start: 'a'` in defineFlow(...)". None of the flow-definition errors cite `defineFlow`, `flow.ts`, or a concrete line to edit.
- **Suggested fix:** Include the next-action command in every `FlowDefinitionError.message`. E.g. `'flow has multiple root steps (a, b). Set `start: "a"` in defineFlow(...) to pick an entry.'` This is a relatively cheap pass across graph.ts and define.ts.
- **Decision:**: fix now, client facing error messages cannot leave user without guidence how to handle the case. If there is an unknown error - there should be generic message like create issue on github.

### FLAG-8 · `step.prompt({ output: { handoff: 'x', schema } })` does not yet check provider `structuredOutput` capability

- **File:** `packages/core/src/flow/steps/prompt.ts`, `packages/core/src/flow/graph.ts` (no capability check present)
- **Spec:** tech spec §4.6.7 — "When `Runner.run()` loads a flow, it walks every step and checks the resolved provider's capabilities against the step's requirements." Sprint-2 target (focus area #6) flags that capability negotiation is likely-not-in-sprint-2. This is not a spec violation for sprint 2 itself, but the location of the check is a design question.
- **Finding:** Capability negotiation is deferred — which is the right call for sprint 2. But nothing in sprint-2 code documents where the check belongs. When sprint-5 or later adds it, the natural home is `defineFlow` (fail-fast at flow load) — but `defineFlow` doesn't currently have the `ProviderRegistry` in scope. Leaves a design gap for a later sprint.
- **Suggested fix:** Add a TODO comment at `define.ts:43` noting "capability negotiation happens at Runner.run() time, not here" so the next author doesn't rediscover the seam.
- **Decision:**: let's add a todo comment.

### FLAG-9 · `runCommand` reuses the `stepId` non-empty-string schema — semantic mis-fit

- **File:** `packages/core/src/flow/schemas.ts:8`
- **Spec:** §4.4.2 `run: string | string[]` — the string is shlex-split at runtime.
- **Finding:** `runCommand = z.union([stepId, z.array(stepId).min(1)])` — `stepId` is a non-empty string primitive reused here because it happens to share the "non-empty" constraint. Works but couples two semantically distinct validators: a change to `stepId` (e.g., adding a regex for valid step ids) would silently tighten `run` validation and reject valid shell commands.
- **Suggested fix:** Define a separate `nonEmptyString = z.string().min(1)` primitive and have both `stepId` and `runCommand` derive from it. One line of cleanup.
- **Decision:** fix now - suggested fix is correct

### FLAG-10 · `ParallelStepSpec` inherits `StepBase` including `maxRetries`, `timeoutMs`, `contextFrom` — over-broad vs spec

- **File:** `packages/core/src/flow/types.ts:41-44`
- **Spec:** tech spec §4.4.4 — `ParallelStepSpec = { branches: string[]; dependsOn?: string[]; onAllComplete?: string; onFail?: 'abort' | string }`. Nothing else.
- **Finding:** Because the implementation uses `extends StepBase`, parallel steps silently accept `maxRetries`, `timeoutMs`, `contextFrom`, and allow `onFail: 'continue'` (spec only mentions `'abort' | string`). Same issue on `TerminalStepSpec` — spec §4.4.5 only lists `message`, `exitCode`, `dependsOn`. Users hitting autocomplete see these fields and will assume they work; the runner will either ignore them or behave surprisingly.
- **Suggested fix:** Split `StepBase` into the actually-shared minimum (`dependsOn` alone) and have each per-kind spec type explicitly add its own timeout/retry/context fields where spec allows. Or: leave the inheritance and add runtime refinements in `parallelStepSpecSchema` / `terminalStepSpecSchema` that reject the out-of-spec keys.
- **Decision:** fix now. We must follow SOLID principles so creating a base interface / abstract class that will be extended / implemented by other is the right approach.

### FLAG-11 · `parallelStepSpecSchema` does not check that branches are not self-referential or duplicates

- **File:** `packages/core/src/flow/schemas.ts:62-66`, `packages/core/src/flow/graph.ts:56-63`
- **Spec:** tech spec §4.4.4 — "branches must already exist as separate steps." Does not forbid self-referential or duplicate branches outright, but both are obviously wrong.
- **Finding:** `step.parallel({ branches: ['self', 'self'] })` passes both the schema and `buildGraph`. `step.parallel({ branches: ['self'] })` where `self` is the parallel step itself will fail via the cycle check (parallel depends on self via dependsOn, if set) but if `dependsOn` doesn't include self, the branches list silently references the parallel step. Cheap win; one `new Set(branches)` compare, plus one equality check.
- **Suggested fix:** Add refinements: "branches must be unique" and "branches cannot include the parallel step's own id." Error messages should quote the offending branch id.
- **Decision:**: fix now. Valid concern. Use zod if possible during defineFlow so we early check if the steps structure is correct. Or do it in business logic with proper domain error.

### FLAG-12 · `defineFlow` double-validates `start` — first in `flowSpecInputSchema`, then in the body, then in `buildGraph`

- **File:** `packages/core/src/flow/define.ts:16-18`, `packages/core/src/flow/graph.ts:221-225`
- **Spec:** Cleanliness only.
- **Finding:** The `start` existence check happens twice: once in `defineFlow` (line 16-18) and once in `buildGraph.resolveEntry` (line 222). Messages are slightly different ("flow start references unknown step" vs `start step "${start}" is not defined in this flow`). A user who triggers this sees one or the other depending on code path; a tree-shaking refactor that bypasses one of them would silently regress.
- **Suggested fix:** Remove the check from `defineFlow` — `buildGraph` already owns graph-level validation. `defineFlow`'s job is to normalize ids and delegate.
- **Decision:** fix now - we must ensure validation happens on a proper layer. Rule of thumb do not pass corrupt data downstream and fail as fast as possible.

### FLAG-13 · `@relay/core` index re-exports `step` namespace but not the underlying builder functions

- **File:** `packages/core/src/index.ts:43`
- **Spec:** §4.2 public API — shows `step` as the exported symbol; doesn't require the individual builders. Sprint-task_18 description says "Re-export defineFlow, step, and Flow, FlowSpec, all Step spec types."
- **Finding:** Task-correct. But `step.ts` itself re-exports the spec types (`packages/core/src/flow/step.ts:15-22`) which are already re-exported from `index.ts` — a harmless duplicate re-export. Worth a note: if `step.ts` stops re-exporting them, nothing in user-land breaks because the types come from `index.ts`. Low-stakes dead code.
- **Suggested fix:** Remove the `export type { ... }` block from `step.ts` — it's redundant with `index.ts` and creates two import paths for the same symbol. Cleanup, not a correctness issue.
- **Decision:** fix now - suggested fix is correct

---

## PASS (satisfies spec)

- `Step` discriminated union is narrowable via `step.kind` (types.ts:51-57). Each variant has a distinct `kind` literal.
- `PromptStepSpec` field list matches tech spec §4.4.1 table exactly: `promptFile`, `provider?`, `model?`, `tools?`, `systemPrompt?`, `contextFrom?` (via StepBase), `output`, `dependsOn?`, `maxRetries?`, `maxBudgetUsd?`, `timeoutMs?`, `onFail?`, `providerOptions?`.
- `RunState` / `StepState` shapes in types.ts:83-106 match tech spec §4.8.1 byte-for-byte (status literals, optional fields, timestamp shape).
- `buildGraph` detects cycles and reports the offending path (`graph.ts:162-164`, `traceCycle` at 179-214). Error type is `FlowDefinitionError` as required by the boundary rule.
- `buildGraph` returns `Result<FlowGraph, FlowDefinitionError>` — no bare throws in the DAG builder itself. Matches the @relay/core boundary rule.
- `defineFlow` returns `Result<Flow<TInput>, FlowDefinitionError>` — matches the boundary rule. Zod input validation goes through `toFlowDefError` which wraps with a human-readable prefix.
- `defineFlow` flow-level validation matches task_18: kebab-case name, semver-ish version, Zod schema for `input` (schemas.ts:75-88).
- All five step builders return `Result<_, FlowDefinitionError>` and validate via Zod before constructing the step object.
- `buildGraph` validates every `dependsOn` reference, every `parallel.branches` reference, every `onFail` step-id target, every `onExit` value, and every `contextFrom` handoff producer (graph.ts:44-99 and 258-311). Task_17 (a)–(e) all covered.
- `rootSteps` is computed as the set of zero-in-degree steps; `entry` resolution handles "no start + one root / no start + multiple roots / no start + zero roots" per task_17 (graph.ts:216-249).
- `index.ts` re-exports the full public surface listed in task_18: `defineFlow`, `step`, `Flow`, `FlowSpec`, `FlowGraph`, `Step`, `StepBase`, `StepKind`, `RunState`, `RunStatus`, `StepState`, `StepStatus`, and all five `*StepSpec` types plus `PromptStepOutput`. Nothing missing from the sprint-2 public API.

---

## Other follow-ups (out of sprint scope)

- **Capability negotiation (§4.6.7) has no home yet.** The step builders do not have a `ProviderRegistry` in scope, and `defineFlow` does not take one either. When sprint-5+ wires capability checks at flow-load time, the natural seam is either an extra argument to `defineFlow` or a lazy check inside `Runner.run()`. Not a sprint-2 miss.
- **Test coverage.** Sprint-2 review is not a test review, but worth flagging for the test-engineer's pass: every `if / else` in `buildGraph` should have a regression — especially the `resolveEntry` three-way branch (one root / zero roots / multi-root) and each of the five reference-validation errors. The cycle-tracing path (`traceCycle` lines 193-213) has three return points; only one is commonly exercised.
- **`FlowGraph` shape duplicates `rootSteps` and `entry`.** `rootSteps` is a list; `entry` is the resolved singular start. `Flow` re-exports `rootSteps` at top level from the graph (`define.ts:42`). A consumer wanting "the steps to start executing" has to pick between `flow.graph.entry`, `flow.graph.rootSteps`, and `flow.rootSteps`. Worth a follow-up to clarify which of these the runner actually reads — and drop the others.
- **Branch/script schema `onExit` value union.** Spec §4.4.2 documents `onExit: Record<string, string>` with the string being a step id or `"abort"`. The implementation also accepts `"continue"` (via `onExitValue`). Either tighten the schema or amend the spec to mention `"continue"`.
- **ParallelStepSpec `onFail: 'continue'`.** Spec §4.4.4 explicitly says `onFail: 'abort' | string` (no `'continue'` for parallel). Because parallel inherits StepBase's `onFail` union which includes `'continue'`, users can set it. If the runner doesn't know what "continue past a failed parallel" means, this will bite.

---

_Generated by code-reviewer agent. Decisions pending from the sprint lead._
