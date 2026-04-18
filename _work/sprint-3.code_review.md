# Sprint 3 — Runtime State Primitives — Code Review

Scope: `handoffs.ts`, `template.ts`, `state.ts`, `cost.ts`, `providers/registry.ts`, `testing/mock-provider.ts`, `testing/index.ts`, `context-inject.ts`, `index.ts` re-exports. Assessed against tech spec §4.5, §4.6.5, §4.7, §4.8, the adopted sprint-4 boundary rule (`@relay/core` returns `Result<T, E>`; no bare `throw` in `@relay/core/**` except inside `stream()` generator bodies), and the `InvocationResponse.costUsd`-is-optional post-follow-up type surface.

---

## BLOCK — must fix before merge

### BLOCK-1 — `HandoffStore.write` throws instead of returning `Result`

- File: `packages/core/src/handoffs.ts`
- Lines: 15–32 (and the read path at 34–52)
- Spec / policy quoted:
  - Adopted boundary rule: "`@relay/core` returns `Result<T, E>` from neverthrow. No bare `throw` inside `@relay/core/**` except inside `stream()` generator bodies where the iterator terminates on error."
  - Sprint-3 JSON says handoff writes use atomicWriteJson (task_7) and `throw HandoffSchemaError` — that is the pre-Result-flip contract that has since been superseded by the core-wide boundary rule.
- What's wrong: Every hot path in `HandoffStore` (`write`, `read`, arguably `list` on readdir failures too) throws. `write` throws `HandoffSchemaError` on schema miss and propagates the atomic-write error via `throw writeResult.error`. `read` throws on JSON parse and schema miss. These are exactly the "hot paths (state transitions, handoff writes)" the reviewer brief calls out as BLOCK-level under the boundary rule. Handoffs participate in the step lifecycle and the Runner will consume them — the Runner cannot safely assume the unwrap-and-propagate contract if the primitive throws.
- Impact: Any caller in `@relay/core` (already: `context-inject.ts::loadHandoffValues`) now has to wrap these in `try/catch` or a `fromThrowable`/`fromPromise` adapter at call sites, which defeats the neverthrow discipline and is the exact drift that prompted the sprint-4 flip.
- Decision: use result pattern from neverthrow

### BLOCK-2 — `StateMachine` mutation methods all throw on the hot path

- File: `packages/core/src/state.ts`
- Lines: 66–123 (`startStep`, `completeStep`, `failStep`, `skipStep`, `markRun`, `save`), 140–146 (`#requireStep`), 157–159 (`loadState`), 162–177 (`verifyCompatibility`)
- Spec / policy quoted: Reviewer brief: "Throws on hot paths (state transitions, handoff writes) are BLOCK." Boundary rule: "`@relay/core` returns `Result<T, E>` from neverthrow."
- What's wrong: Every state transition throws — `illegalTransition`, `unknownStep`, and the propagated atomic-write error in `save()`. `loadState` lets raw `readFile` / `JSON.parse` errors bubble (a corrupt or missing `state.json` produces a bare `Error`, not a typed `Result` variant). `verifyCompatibility` throws `PipelineError` directly.
- Impact:
  1. Runner (sprint 4+) will have to pay for `try/catch` and/or `fromPromise(…, e => PipelineError)` adapters on every transition.
  2. The reviewer brief explicitly calls out "`loadState` handles missing file (fresh run) vs corrupt file vs version-mismatch gracefully — each with a distinct Result variant." Today all three collapse to an uncaught throw with no code discrimination between `ENOENT`, `SyntaxError`, and the version-mismatch path.
- Decision: All need to use result pattern with properly defined errors not generic Error should be used.

### BLOCK-3 — `CostTracker.record` treats `undefined costUsd` as `NaN`

- File: `packages/core/src/cost.ts`, line 69 (`totalUsd += entry.costUsd;`) and the type at line 29 (`costUsd: number`).
- Spec / policy quoted:
  - `InvocationResponse.costUsd` post-sprint-4: "Omit when the provider has no reliable estimate (subscription-billed runs). For subscription-billed providers this reflects a compute-equivalent estimate, not a charge."
  - Reviewer brief: "`costUsd` on `InvocationResponse` is now optional (sprint-4 follow-up) — does `CostTracker.record(...)` handle undefined costUsd? If today it treats undefined as NaN, that's a BLOCK."
- What's wrong: `StepMetrics.costUsd` is declared `number` (non-optional), so a caller that receives `response.costUsd === undefined` (the normal subscription path) has two bad choices: either coerce to `NaN`/`0` at the call site (lossy, and `NaN` will then poison `totalUsd` forever once a single step is missing it), or type-assert past the strictness. The tracker itself has no guard: if a caller ever passes a `StepMetrics` whose `costUsd` is `undefined` via a cast, `totalUsd += undefined` silently becomes `NaN` and every subsequent `summary()` returns `NaN`.
- Minimum fix: make `StepMetrics.costUsd` optional (`costUsd?: number`) and sum as `totalUsd += entry.costUsd ?? 0;`. Consider tracking a `costKnown` count separately so callers can render "estimated API equivalent (N/M steps estimated)".
- Decision: yes, let's make it optional and default to 0. Also track cost known

### BLOCK-4 — `loadHandoffValues` has no `handoff-missing` vs `schema-mismatch` discrimination

- File: `packages/core/src/context-inject.ts`, lines 45–54.
- Spec / policy quoted: Reviewer brief §7: "`loadHandoffValues(handoffStore, ids)` returns `Result<Record<id, unknown>, HandoffSchemaError>`. Missing handoff id: distinct Result variant from schema-mismatch." Spec §4.5.1: `read<T>(id, schema?)` — schema-mismatch-specific error class exists; missing-file currently surfaces as a generic `ENOENT` `Error` from `readFile`.
- What's wrong: Today, `loadHandoffValues` propagates whatever `store.read` throws. A missing handoff becomes a raw `Error: ENOENT: no such file…`; a schema mismatch becomes `HandoffSchemaError`. The boundary contract requires a `Result` with a specific discriminated error variant for each case. Callers cannot tell the two apart programmatically, and the CLI cannot map them to distinct exit codes per §8.2.
- Decision: we must have properly typed errors and use them.

### BLOCK-5 — `HandoffStore` and `StateMachine` filenames are not path-traversal-safe

- Files:
  - `packages/core/src/handoffs.ts`, lines 15, 27, 34, 35, 54, 55 — every join is `join(this.#handoffsDir, \`${id}.json\`)`.
  - `packages/core/src/state.ts` via `RunState.runId` — only indirectly, since the path is `join(runDir, 'state.json')`; run state is fine.
- Spec / policy quoted: Reviewer brief §1 focus area: "Path traversal safety for the handoff id → filename mapping?"
- What's wrong: A flow author (or a handoff produced by model output that feeds back into `write(id, ...)`) can pass `id = '../../etc/passwd'` or `id = '../other-run/state'`, and the store will happily cross directory boundaries. While the handoff id is usually author-supplied and thus semi-trusted, the spec §4.5.3 notes handoffs "cross process boundaries (prompts run in Claude, which is a subprocess)" — any flow that derives an id from model output lets the model escape the run directory. There is no allowlist check on `id` (e.g., `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`), no `path.resolve` sanity check that the resulting path still starts with `this.#handoffsDir`.
- Minimum fix: reject any id containing `/`, `\`, `..`, or leading `.` and return `err(FlowDefinitionError('invalid handoff id'))` before touching fs.
- Decision: we must ensure proper filepaths

### BLOCK-6 — `ProviderRegistry` is the only Result-returning piece; callers must match

- File: `packages/core/src/providers/registry.ts` (current post-sprint-4-follow-up) and `packages/core/src/providers/claude/provider.ts` line 393.
- Spec / policy quoted: Reviewer brief §5: "Are there any callers in `@relay/core` or `@relay/cli` that still treat the return as void / throwing?"
- What's wrong: This is consistent today — `registerDefaultProviders` returns `Result<void, FlowDefinitionError>` and callers are expected to unwrap. However, `registerDefaultProviders` does not gate on `registry.has('claude')` before calling `register`, so calling it twice (tests, hot-reload) returns `err('provider "claude" already registered')`. The JSDoc punts this to the caller ("Idempotency is the caller's responsibility via registry.has('claude')") — which is fine as policy, but there is no helper on the registry itself (`registerIfAbsent`, or `register` being idempotent-safe), and any call site that forgets the check will surface a bogus FlowDefinitionError on a repeat boot. Given the registry is a process-wide singleton (line 33), double-register is a plausible footgun.
- Decision: We must handle it cleanly

---

## FLAG — worth a second look

### FLAG-1 — `HandoffStore.read` lets `readFile` / `JSON.parse` errors bubble unwrapped

- File: `packages/core/src/handoffs.ts`, lines 34–52.
- Observation: Even if BLOCK-1 is resolved by flipping the API to Result, the specific `ENOENT` path should map to a named variant (`HandoffNotFoundError` or a discriminated union `'missing' | 'schema' | 'io'`). Today a missing file and a malformed JSON file both surface as raw `Error`s from node:fs.
- Suggested change: introduce a discriminated error union and wrap the read path in `fromPromise` with an error mapper; return the discriminated error on the `err` branch.
- Decision: fix now, we must create descriptive errors and properly map generic errors to domain specific ones.

### FLAG-2 — `HandoffStore.list` swallows all readdir errors as "empty"

- File: `packages/core/src/handoffs.ts`, lines 64–76.
- Observation: A permissions error, a disk fault, or a handoffs directory that is actually a file will all silently return `[]`. That is not the same as "no handoffs written yet". The spec §4.5.1 does not dictate semantics, but silently hiding I/O errors means a corrupted run directory looks identical to a fresh one.
- Suggested change: distinguish `ENOENT` (fresh run → `[]`) from other `readdir` errors (surface as `err`).
- Decision: fix now

### FLAG-3 — Concurrent-writer race on the same handoff id

- File: `packages/core/src/handoffs.ts`, line 27 and `atomic-write.ts` lines 13–25.
- Observation: Two `set('foo', ...)` calls racing will both `mkdir` → `writeFile` → `rename`. Because the tmp file names include a `randomUUID()`, the two temps will not collide, but `rename` is last-write-wins. This is "atomic per writer" (no torn reads for a third reader) but NOT "serialized across writers". If the flow has two branches that both produce `foo`, whichever's rename happens last wins silently. Sprint-3 scope did not mandate an in-process mutex; the Runner in §4.9 is expected to not schedule two writers for the same handoff id via the DAG. Still worth an explicit doc comment on `HandoffStore.write` noting "caller guarantees single writer per id".
- Suggested change: doc comment on `write()` stating the single-writer-per-id assumption; consider a simple in-process `Map<id, Promise<void>>` to chain concurrent writes to the same id.
- Decision: fix now, we must properly use mutex so wirtes are truly atomic

### FLAG-4 — Template missing-path becomes empty string (per spec), but HTML-escaping is off (also per spec, implicitly)

- File: `packages/core/src/template.ts`, lines 67–77 and 102–106.
- Observation: Missing path → empty string with a debug log — matches spec §4.5.2 and task_20 description. No HTML escaping — correct, because the output feeds a prompt, not a web page. Also no "second-pass" template evaluation of resolved values, which is good (user-supplied values cannot be evaluated as templates). Mention this as a PASS with a caveat: if a handoff value itself contains `{{…}}`, it is rendered as the literal braces — confirm this is what flow authors expect. Worth asserting in a test.
- Suggested change: add a unit test that proves `renderTemplate('{{x}}', { x: '{{y}}' })` returns the literal `'{{y}}'`, not an empty string or a second-pass substitution.
- Decision: fix later, we will write tests later.

### FLAG-5 — Template `.` current-item convention relies on user variables not containing a `.` key

- File: `packages/core/src/template.ts`, line 138–143.
- Observation: Inside an `{{#each arr}}`, the renderer stores the current item under the `.` key of a synthetic scope. The scope chain uses innermost-first lookup (line 68), so the `.` sentinel is safe. But if a handoff object has a top-level key literally named `.` (rare, but allowed by JSON), an inner `{{.}}` inside an outer scope would hit that key first. Extremely unlikely in practice, but the sentinel is not a symbol, it is a string. Consider using a Symbol or a non-user-producible key (e.g., `__relay_each_item__`).
- Decision: fix now - use Symbol

### FLAG-6 — Template renderer also iterates the outer scope on a bare `{{#each}}` of a non-object value

- File: `packages/core/src/template.ts`, lines 138–141.
- Observation: For a primitive array element (e.g., strings), the item scope is `{ '.': item }` — resolve `{{field}}` against it falls through to outer scopes, which is probably fine. For an array-of-arrays, `{{field}}` inside the inner block will NOT iterate — the array spread path is gated on `!Array.isArray(item)`. Arrays-of-arrays are therefore only accessible via `{{[i]}}` or further `{{#each .}}`. Spec §4.5.2 doesn't speak to this. Document the behavior in the jsdoc.
- Decision: I think we should consider using a third-party library for ease of use instead of writing our own template parsers. Something like https://handlebarsjs.com/guide/ or something more modern fitting our use case.

### FLAG-7 — `StateMachine.completeStep` cannot mark a step that also emits `aborted`

- File: `packages/core/src/state.ts`, no `abortStep(id)` method exists.
- Spec / policy quoted: `RunStatus = 'running' | 'succeeded' | 'failed' | 'aborted'` — but `StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'` (no per-step abort). That is the spec (`flow/types.ts` lines 83–85), so the state machine matches. But the run-level `markRun('aborted')` does NOT cascade-mark any still-`running` steps; they will be left in the `running` status on disk after a SIGINT.
- Suggested change: make `markRun('aborted')` sweep `steps` and flip any `running` entry to `failed` with `errorMessage: 'run aborted'`, or add an explicit `abortRun()` convenience method.
- Decision: fix now with suggested change

### FLAG-8 — `StateMachine.failStep` unconditionally marks the whole run failed

- File: `packages/core/src/state.ts`, lines 96–109.
- Observation: A step with `onFail: 'continue'` (see `StepBase.onFail` in `flow/types.ts`) should NOT flip the run-level status. The state machine here does not know about `onFail`, so it fails the run on every step failure. The Runner (sprint-5) will need to either not call `failStep` for continue-on-fail steps, or this method needs an `{ continueRun?: boolean }` option.
- Suggested change: remove the `this.#state = { ...this.#state, status: 'failed', …}` mutation from `failStep`; have the Runner call `markRun('failed')` explicitly when abort semantics fire.
- Decision: fix now I am okay with suggested change

### FLAG-9 — `StateMachine.startStep` resets `completedAt` / `errorMessage` from a prior failed attempt

- File: `packages/core/src/state.ts`, lines 71–76.
- Observation: The check is `if (step.status !== 'pending')`. After a `failStep`, the step is `failed`, and you cannot restart it — the Runner must reset to `pending` somewhere. If the resume protocol (§4.8.2) re-runs failed steps "from scratch", there is no API here to do that reset. A resume path would call `init()` with the full step list, which wipes all prior step state (attempts, timestamps, artifacts). That is more aggressive than §4.8.2 step 3 wants ("steps that are `succeeded` — skip those. Re-execute everything else"): the attempts counter is lost.
- Suggested change: add `resetStep(id)` that flips `failed` → `pending` and preserves the attempts counter so `maxRetries` accounting survives resume; document the resume flow that calls it.
- Decision: fix now, I am okay with suggested fix

### FLAG-10 — `MockProvider.stream` throws a `PipelineError`, which is the approved escape, but `invoke` and `stream` can diverge

- File: `packages/core/src/testing/mock-provider.ts`, lines 74–91.
- Observation: The spec's boundary rule allows the throw inside `stream()` generator bodies. Good. `invoke()` returns `err(PipelineError)`. That matches. BUT the thrown error in `stream` line 77 is the exact `result.error` from `resolveResponse` — and `resolveResponse` returns `StepFailureError` on a missing stepId. Tests that iterate `stream` will see `StepFailureError`, tests that call `invoke` will see `Result<_, StepFailureError>`. Both paths are consistent. Document the contract: "stream throws the same PipelineError type that invoke would have returned in the err branch."
- Decision: fix now, I am okay with suggested change

### FLAG-11 — `MockProvider.stream` never yields `turn.start`

- File: `packages/core/src/testing/mock-provider.ts`, lines 74–91.
- Observation: `InvocationEvent` discriminated union includes `{ type: 'turn.start'; turn: number }`. The mock only yields `text.delta`, `usage`, `turn.end`. Tests that assert the full event sequence may need `turn.start` first.
- Suggested change: yield `{ type: 'turn.start', turn: 1 }` before the `text.delta`.
- Decision: fix now, I am okay with suggested change

### FLAG-12 — `resolveResponse` fires the response function on every call to `invoke` AND on `stream`

- File: `packages/core/src/testing/mock-provider.ts`, lines 49–65, 67–72, 74–91.
- Observation: Reviewer brief §6: "Response factory fires exactly once per invoke / stream call." It does today — invoke calls `resolveResponse` once, stream calls `resolveResponse` once, both via the same method. The sprint-4 follow-up that made `stream` not route through `invoke` is confirmed: line 75 calls `resolveResponse` directly. Good.
- Decision: nothing to change

### FLAG-13 — `atomicWriteJson` wraps the error type as generic `Error`, not `PipelineError`

- File: `packages/core/src/util/atomic-write.ts`, line 8 signature.
- Observation: Callers in `handoffs.ts` line 30, `state.ts` line 136, `cost.ts` line 56 do `throw writeResult.error` — where `writeResult.error: Error`. That means the throw surfaces a plain `Error`, not a `PipelineError` with a relay code. If any of those flips to `Result` per BLOCK-1/BLOCK-2, the error variant on the `err` branch should be a named PipelineError (e.g., `StateWriteError`, `HandoffWriteError`), not the bare `Error` from node:fs.
- Suggested change: wrap atomic-write failures in a named PipelineError subclass at each call site during the Result-flip.
- Decision: fix now, I am okay with suggested change

### FLAG-14 — `CostTracker.load` silently discards non-array contents

- File: `packages/core/src/cost.ts`, lines 85–101.
- Observation: A malformed `metrics.json` (non-array, or `JSON.parse` throws) is silently treated as empty. The `JSON.parse` call on line 94 is NOT in a try block — if it throws on a malformed file, the throw escapes, which contradicts the spec intent of "silently resolves with an empty list when metrics.json does not yet exist" (only covers the `ENOENT` case, not the corrupt case). Inconsistent behavior.
- Suggested change: wrap `JSON.parse` in a try/catch that resets `#entries = []`; better, return a `Result` that distinguishes "no file" from "corrupt" so the Runner can warn on the latter.
- Decision: I think we shold have a json utils that will read json safely. Use json.parse and use zod for schema validaton to ensure json has proper structure.

### FLAG-15 — `CostTracker` does not expose per-model aggregation

- File: `packages/core/src/cost.ts`, lines 64–78.
- Observation: Reviewer brief §4: "Aggregations (total, per-step, per-model) don't silently drop zero-cost entries." Per-model aggregation doesn't exist. §4.7 only mentions `summary(): { totalUsd; totalTokens; perStep: StepMetrics[] }`, so the current shape matches the spec letter, but the live-status and doctor commands will eventually want per-model. Not a BLOCK — sprint-3 spec doesn't demand it.
- Decision: if we can provide such information we should add it right now so all required data is properly agregated.

### FLAG-16 — `context-inject.ts` handoff value order is Object.entries' insertion order

- File: `packages/core/src/context-inject.ts`, lines 32–34.
- Observation: Spec §4.5.2 gives an example with two `<context>` blocks and does not specify order. The implementation uses `Object.entries(handoffs)`, whose order is object-literal insertion order for string keys. `loadHandoffValues` (lines 45–54) populates `result[id] = …` in input-order, so the ordering cascades. Fine. Worth asserting in a test so no one accidentally reorders via `Object.fromEntries(Object.entries(x).sort())`.
- Decision: I don't think order of context tags matter for AI, all that matters is that it's there. We can improve the context tag to treat it as a list and have structure like <context><c>{context A}</c><c>context B</c></context>.

### FLAG-17 — `assemblePrompt` does not escape handoff JSON that contains `</context>`

- File: `packages/core/src/context-inject.ts`, line 33.
- Observation: A handoff value containing the literal substring `</context>` in a string will break out of the tagged block. `JSON.stringify` preserves `</context>` inside a quoted string, so a Claude prompt could see a tag-close inside what is supposed to be JSON and misread the structure. Unlikely in practice (requires the flow author's own handoff to embed the tag name), but worth either escaping `<` → `\u003c` (the standard Node/React technique) or documenting the risk.
- Suggested change: pass a replacer to `JSON.stringify` or post-process with `.replace(/</g, '\\u003c')`.
- Decision: We can create json-utils with saveStrigify, saveParse, that properly handles xml tag structures OR look for a third-party library that will handle it for us.

### FLAG-18 — `state.ts` imports `RunState` / `RunStatus` / `StepState` from `flow/types.js`

- File: `packages/core/src/state.ts`, line 5.
- Observation: Types are sourced from sprint-2 `flow/types.ts`. Matches the sprint-3 dep chain. Fine.
- Decision: ok

### FLAG-19 — `index.ts` does NOT re-export `MockProvider`

- File: `packages/core/src/index.ts`.
- Observation: Reviewer brief §11: "`MockProvider` is exported via `@relay/core/testing` subpath. Confirm shape." Subpath export lives at `packages/core/src/testing/index.ts` and only re-exports `MockProvider` and `MockProviderOptions`. The main `index.ts` does not re-export `MockProvider`, which is correct — it is test-only and travels on the `/testing` subpath. Assuming the `package.json` subpath export ("./testing") is present (not reviewed here; sprint-0/2 concern), the shape is correct.
- Decision: let's verify package.json structure to ensure everything is correct.

### FLAG-20 — `state.ts` `loadState` bypasses the `StateMachine.load()` class method

- File: `packages/core/src/state.ts`, lines 125–129, 157–160.
- Observation: `StateMachine.load()` delegates to the free function `loadState(runDir)`. That's clean, but `StateMachine.load()` does not call `verifyCompatibility` automatically — the caller must do that. The spec §4.8.2 says the resume protocol must "Verify the flow definition still matches" as step 2, which is a Runner concern, not a StateMachine concern. Acceptable, but the contract would read better with a `StateMachine.loadAndVerify({ flowName, flowVersion })` convenience that performs both and returns the `RunState` or the error.
- Decision: we should have a single source of state loading with all edge cases covered. Then reuse this one source across the whole code to ensure we load state properly.

### FLAG-21 — `ProviderRegistry.list()` returns a live-backed `readonly` array from Map.values

- File: `packages/core/src/providers/registry.ts`, lines 28–30.
- Observation: `Array.from(this.#providers.values())` copies into a new array, so mutation-through-reference is safe. `readonly Provider[]` at the TS level also prevents mutation. Correct per §4.6.5.
- Decision:

### FLAG-22 — `state.ts::nowIso` uses wall-clock `Date.now()` — test determinism note

- File: `packages/core/src/state.ts`, lines 10–12.
- Observation: The state machine stamps `startedAt`, `updatedAt`, `startedAt` per step using `new Date().toISOString()`. Tests will need fake timers to snapshot. Not a bug — just note in vitest tests.
- Decision:

### FLAG-23 — Comments are self-contained (no `§` refs, no task IDs)

- Files: all sprint-3 files.
- Observation: Skimmed every jsdoc and inline comment — none include `§4.5.1`, `§4.7`, `task_19`, etc. Matches the user-memory rule ("Code comments must be self-contained"). Pass.
- Decision:

---

## PASS

- Atomic writes land everywhere the spec demands: `HandoffStore.write` via `atomicWriteJson` (handoffs.ts:28), `StateMachine.save` via `atomicWriteJson` (state.ts:134), `CostTracker.record` via `atomicWriteJson` (cost.ts:54). No non-atomic writes on state.json, metrics.json, or handoffs/\*.json.
- `StepMetrics` field shape matches §4.7 exactly (stepId, flowName, runId, timestamp, model, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, numTurns, durationMs, costUsd, sessionId, stopReason, isError). Caveat in BLOCK-3 on `costUsd` being non-optional.
- `RunState` / `StepState` shape in `flow/types.ts` matches §4.8.1 exactly (including the `'aborted'` run status and the step statuses pending/running/succeeded/failed/skipped).
- `StateMachine.init(steps)` seeds every step with `{ status: 'pending', attempts: 0 }` per spec.
- Template renderer supports exactly the four syntax forms the spec pins: `{{name}}`, `{{name.path.to.field}}`, `{{name[i].field}}`, `{{#each name}}…{{/each}}`. No helpers, no partials, no conditionals. Missing paths resolve to empty string with a debug log. Unbalanced each-blocks throw `FlowDefinitionError` (the only approved throw-exit here is that this is a pure, synchronous function — not a hot-path state mutator — and the Result-flip for the template renderer is a reasonable follow-up, but the pure-function throw is at most a FLAG; see BLOCK/FLAG list).
- User-supplied values are NOT re-evaluated as templates (no second-pass substitution). Template injection path is closed.
- `assemblePrompt` merges vars in the documented order: `{ input: inputVars, ...handoffs, ...(stepVars ?? {}) }`. StepVars win on collision.
- `assemblePrompt` wraps with `<prompt>\n…\n</prompt>` and prepends `<context name="…">\n…\n</context>\n\n` blocks per §4.5.2 example.
- `MockProvider` default capabilities match the sprint-3 task description: streaming/structuredOutput/tools/multimodal/budgetCap all true, models `['mock-model']`. `authenticate()` returns `ok({ billingSource: 'local', detail: 'mock provider' })`.
- `MockProvider.stream` now synthesizes events directly (not via `invoke`) — sprint-4 follow-up confirmed. `resolveResponse` is the single point of response resolution.
- `MockProvider.invoke` and `.authenticate` both return `Result` — signatures match the current `Provider` interface exactly.
- `ProviderRegistry.register` / `.get` return `Result<_, FlowDefinitionError>`; `.has` / `.list` return plain values per spec §4.6.5. `defaultRegistry` is an empty singleton — sprint-3 does NOT self-register ClaudeProvider; `registerDefaultProviders` (sprint 4) is the only path that does.
- `defaultRegistry` mutation via `register` is check-then-set against the map — double-register does not silently clobber (returns `err`). See BLOCK-6 note about idempotency helpers.
- `index.ts` re-exports the public surface expected by the reviewer brief §11: `HandoffStore`, `StateMachine`, `loadState`, `verifyCompatibility`, `CostTracker`, `StepMetrics` (as type), `assemblePrompt`, `loadHandoffValues`, `ProviderRegistry`, `defaultRegistry`. `MockProvider` intentionally NOT exported from the main entry — lives on the `/testing` subpath via `testing/index.ts`.
- No emojis, no "simply", no trailing `!` in any user-visible string produced by these files. All error messages are sober and diagnostic.
- Comments are self-contained — no spec-section refs, no sprint/task IDs, per the user-memory rule.
- `HandoffStore.list()` strips `.json` extension and sorts alphabetically per sprint-3 task description.
- `verifyCompatibility` compares both `flowName` AND `flowVersion` and surfaces the mismatch with both expected and actual in `details` — useful for the CLI.

---

## Other follow-ups (pointing at later-sprint code)

- `packages/core/src/providers/claude/provider.ts::registerDefaultProviders` (line 390) punts idempotency to the caller. Sprint-5 Runner bootstrap should pair with `registry.has('claude')` OR the registry should grow a `registerIfAbsent` helper. Tracked implicitly via BLOCK-6.
- Sprint-5 Runner will need to decide where `loadHandoffValues` plugs in. Today, `assemblePrompt` takes a pre-loaded `handoffs: Record<string, unknown>` — the Runner is expected to call `loadHandoffValues` first. Document that dependency order when the Runner lands.
- The `onFail: 'continue'` path (FLAG-8) is not Runner-aware in `StateMachine.failStep`. Sprint-5 should decide whether to gate `failStep`'s run-status flip on an argument or to move that responsibility out of the state machine entirely.
- The aborted-steps sweep (FLAG-7) is a Runner concern; `markRun('aborted')` should either cascade or the Runner should loop through `running` steps and call an `abortStep(id)` method that doesn't yet exist.
- `atomicWriteJson`'s error type is the bare `Error` from node:fs (FLAG-13). Sprint-5 Runner integration work should wrap these in a named `PipelineError` subclass — `StateWriteError` / `HandoffWriteError` / `MetricsWriteError` — so the CLI can map to exit codes per §8.2.
- CostTracker per-model aggregation (FLAG-15) will be wanted by the CLI's `--cost` flag and the live-status display. Spec §4.7 doesn't mandate it in v1, but a follow-up sprint should extend `summary()`.
