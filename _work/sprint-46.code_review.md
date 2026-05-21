# Sprint 46 · Interactive (human-in-the-loop) flows via step.ask and paused run state — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `6945348` (feat(core): foundation for ask-step paused-run state)
- `995c988` (feat(core): step.ask builder, executeAsk executor, and DAG validation for dynamic question sources)
- `6742fdc` (feat: orchestrator pause protocol, paused banner, and public ask exports)
- `c9186c3` (feat: resume protocol for paused runs, paused-run guard in resume command, and interactive generator template)
- `699f761` (feat: relay answer command, ask-step tests, and end-to-end pause/resume wiring)
- `8c5ae64` (test(cli): cover relay answer command — guards, --json mode, resume invocation, exit codes)

**Summary:** 1 BLOCK, 6 FLAG, 18 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Decision verifications (A–G)

### A — `step.ask` is the step name (not `step.pause`, `step.input`, `step.question`) — **PASS**

- `packages/core/src/flow/step.ts:16` exposes `ask: askStep`.
- `packages/core/src/flow/steps/ask.ts:24` exports `askStep(spec)`.
- `packages/core/src/flow/types.ts:4` adds `'ask'` to the `StepKind` union.
- Generator template uses `step.ask({ ... })` at `packages/generator/templates/interactive/flow.ts:22`.
- **Decision:**

### B — Always cold-pause (no inline TTY mode in this implementation) — **PASS**

- `packages/core/src/orchestrator/exec/ask.ts:158` unconditionally throws `AwaitingInputSignal` once questions are resolved; no TTY branch.
- `packages/core/src/orchestrator/orchestrator.ts:1463-1510` catches the signal in `dispatchStep`, calls `pauseStep`, persists state via `save()`, fires `abortController.abort()` to cascade-abort sibling parallel branches, then re-throws the signal so the walker sees the paused outcome.
- The CLI's `relay answer` is the only path that supplies answers; no inline prompting inside `relay run`.
- **Decision:**

### G — Answer handoff shape is `Record<questionId, answerValue>`; key convention is `__ask_<stepId>__` — **PASS**

- `packages/core/src/flow/question.ts:77` defines `AnswerMap = Record<string, unknown>`.
- `packages/core/src/orchestrator/exec/ask.ts:52-54` defines `askAnswerHandoffKey(stepId) = '__ask_' + stepId + '__'`.
- `packages/core/src/orchestrator/exec/ask.ts:65` defines `AnswerMapSchema = z.record(z.string(), z.unknown())`.
- The CLI writes via `atomicWriteJson` (`packages/cli/src/commands/answer.ts:303`); the orchestrator reads via `readFile` directly (`packages/core/src/orchestrator/exec/ask.ts:113`); both bypass `HandoffStore` because the key has a leading underscore.
- After a successful read on resume, the orchestrator re-publishes the answer map under the **bare step id** as a normal handoff via `handoffStore.write(step.id, answers, step.output?.schema)` (`packages/core/src/orchestrator/orchestrator.ts:1305`), and `handoffNameOf(step)` returns `step.id` for ask kinds (`packages/core/src/flow/graph.ts:379-381`) so `contextFrom` resolution works. Concern #2 verified.
- **Decision:**

### F — Six question kinds: text, multiline, select, multiselect, confirm, number — **PASS**

- `packages/core/src/flow/question.ts:1-58` defines all six per-kind schemas and the discriminated union `QuestionSchema`.
- `packages/core/src/flow/question.ts:64` exports `QuestionKind = 'text' | 'multiline' | 'select' | 'multiselect' | 'confirm' | 'number'`.
- The CLI's `askQuestion()` switch (`packages/cli/src/commands/answer.ts:62-149`) handles every kind with kind-appropriate prompting and validation.
- **Decision:**

### E — `paused` is added to `FlowStatus` and `StepStatus`; `awaitingInput` is in `RunState` schema — **PASS**

- `packages/core/src/flow/types.ts:192` `FlowStatus = 'running' | 'succeeded' | 'failed' | 'aborted' | 'paused'`.
- `packages/core/src/flow/types.ts:194` `StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'paused'`.
- `packages/core/src/flow/types.ts:211-215` defines `AwaitingInput = { stepId, questions, promptedAt }`.
- `packages/core/src/state.ts:30,52,57` extends both schemas with `'paused'` and `awaitingInput.optional()`.
- **Decision:**

### C — Both static `questions[]` and dynamic `{ from: string }` are supported — **PASS**

- `packages/core/src/flow/types.ts:148` `questions: Question[] | DynamicQuestionSource`.
- `packages/core/src/flow/schemas.ts:171` `questions: z.union([QuestionsArraySchema, DynamicQuestionSourceSchema])`.
- Static branch: `packages/core/src/orchestrator/exec/ask.ts:144-145`.
- Dynamic branch: `packages/core/src/orchestrator/exec/ask.ts:146-152` reads via `handoffStore.read(spec.questions.from, QuestionsArraySchema)` so an upstream producer that writes a malformed list surfaces as a typed `HandoffSchemaError`.
- DAG-time validation: `packages/core/src/flow/graph.ts:508-588` rejects unknown handoffs, non-preceding handoffs, and loop-scoped handoffs with targeted error messages.
- Tests cover all three rejection paths (`packages/core/tests/flow/ask.test.ts:288-344`).
- **Decision:**

### D — `relay answer` exists and auto-resumes; `relay resume` refuses paused runs — **FLAG-1**

- `relay answer` is registered in `dispatcher.ts:42` and `dispatcher.ts:174-181` with the `--json` option.
- `packages/cli/src/commands/answer.ts:333-364` constructs an `Orchestrator` and invokes `orchestrator.resume(runDir, { logToStdout: !process.stdout.isTTY })` after writing the answer file.
- `packages/cli/src/commands/resume.ts:277-281` refuses paused runs with the brand-spec message `⚠ this run is paused waiting for input` + hint `provide answers with: relay answer <runId>` and exits 1.
- See **FLAG-1** for an asymmetry on the first run path: `relay run` does not yet recognise the orchestrator's `status: 'paused'` outcome.
- **Decision:**

---

## Project constraint verifications

### All fallible public functions return `Result<T,E>` via neverthrow — **PASS**

- `StateMachine.pauseStep` and `StateMachine.resumePausedStep` both return `Result<void, StateTransitionError>` (`packages/core/src/state.ts:291-318, 327-356`).
- `executeAsk` returns `Promise<Result<AnswerMap, AskExecError>>` (`packages/core/src/orchestrator/exec/ask.ts:96-101`).
- The single intentional throw — `AwaitingInputSignal` at `packages/core/src/orchestrator/exec/ask.ts:158` — is documented as a control-flow signal in `errors.ts:885-897` and called out as the explicit exception in the executor's docblock at `exec/ask.ts:38-44`.
- **Decision:**

### No emojis in any output, code, or template — **PASS**

- Searched `packages/cli/src/commands/answer.ts`, `paused-banner.ts`, `templates/interactive/*`, `flow/question.ts`, `flow/steps/ask.ts`, `orchestrator/exec/ask.ts`, `state.ts`, `errors.ts`. Symbols used (`✓ ✕ ⚠ ⊘ ●─▶ ○ ·`) all come from the brand vocabulary via `SYMBOLS` / `MARK`. No standalone emoji code points found.
- **Decision:**

### `simply` does not appear in any user-visible string — **PASS**

- `grep -nE '\bsimply\b'` returns zero hits across all sprint-46 source and template files.
- **Decision:**

### Atomic writes for state.json and handoffs — **PASS**

- `StateMachine.save` uses `atomicWriteJson` and serializes through `createWriteSerializer()` (`packages/core/src/state.ts:402-416`).
- `pauseStep` mutates in-memory only; the orchestrator calls `stateMachine.save()` immediately after at `packages/core/src/orchestrator/orchestrator.ts:1485`.
- The CLI's answer file write goes through `atomicWriteJson` (`packages/cli/src/commands/answer.ts:303`).
- The CLI's post-answer state save goes through `machine.save()` (`packages/cli/src/commands/answer.ts:325`).
- **Decision:**

### `AwaitingInputSignal` is documented as internal — **PASS**

- `packages/core/src/errors.ts:885-897` carries the docstring `Internal signal thrown by the ask executor when a step requires human input and caught by the orchestrator to pause the run. Not part of the public neverthrow Result API — callers should never catch this in application code.`
- `packages/core/src/orchestrator/exec/ask.ts:38-44` repeats the contract at the executor level.
- The class is exported from `@ganderbite/relay-core` so the orchestrator (and tests) can `instanceof`-check it; the docstring is the contract that keeps it out of application code.
- **Decision:**

### No spec section references in code comments — **PASS** (sprint-46 files only)

- All sprint-46 NEW files (`flow/question.ts`, `flow/steps/ask.ts`, `orchestrator/exec/ask.ts`, `cli/src/commands/answer.ts`, `cli/src/paused-banner.ts` ask-paused additions, generator templates) contain no `§x.y` references.
- Pre-existing `§` refs remain in `cli/src/commands/resume.ts:5,103,405` and `cli/src/paused-banner.ts:8` — both files were touched in sprint 46 but not the offending header lines (verified with `git blame`). Out of scope for this sprint; logged under "Other follow-ups".
- **Decision:**

### No `task_N` or `FLAG-N` in any commit message — **PASS**

- `git log --format=%B 6945348..HEAD | grep -E '(task_|FLAG-|BLOCK-)'` returns only the sanctioned `Closes task_X, task_Y from _work/sprint-46.json` traceability lines, exactly per the project convention. No spurious sprint-internal identifiers in subjects or bodies.
- **Decision:**

### Native `z.toJSONSchema`, no third-party `zod-to-json-schema` — **PASS**

- No new third-party JSON schema package added by sprint 46. The orchestrator already calls `z.toJSONSchema(...)` at `packages/core/src/orchestrator/orchestrator.ts:933,945` for prompt-step schema export. No JSON-Schema conversion happens for ask steps (the answer-map schema is consumed at the Zod level only).
- **Decision:**

### Domain-generic error names — **PASS**

- The new control-flow class is `AwaitingInputSignal` — domain-generic, no provider name baked in. No new error classes were added in sprint 46.
- **Decision:**

---

## BLOCK · 1

### BLOCK-1 · `relay run` does not handle the orchestrator's `paused` outcome — silent regression to failure-banner + exit 1

- **File:** `packages/cli/src/commands/run.ts:392-481`
- **Spec / decision:** Decision D ("`relay answer` command exists and auto-resumes; `relay resume` refuses paused runs"). The complementary first-run case is not stated explicitly in decisions A-G but is required for the design to function end-to-end: `RunResult.status: 'paused'` is a first-class orchestrator outcome (`packages/core/src/orchestrator/orchestrator.ts:159`), and `EXIT_CODES.paused = 75` is reserved for it (`packages/cli/src/exit-codes.ts:15,59`).
- **Finding:** `run.ts`'s post-run dispatch has three branches: `result.status === 'succeeded'` (line 392), `result.status === 'aborted' && wasInterrupted` (line 429, the Ctrl-C path), and `else` (line 447, "failed or aborted"). When a flow contains an `step.ask` and the user invokes `relay run`, the orchestrator returns `{ status: 'paused', pausedStepId: ... }`. The current code falls into the `else` branch, renders the **failure** banner via `renderFailureBanner(...)`, fires telemetry with `status: 'aborted' ? 'aborted' : 'failure'` (treating paused as failure), and exits with code 1 instead of 75. The end-to-end pause/resume UX promised by sprint 46 only works on `relay answer` (which wraps a _resume_); the _first_ time a flow hits an ask step, the user sees a failure banner rather than the paused banner with `answer: relay answer <runId>` hint. The `answer` command's resume path is correct (`commands/answer.ts:342-349`), and so is `resume.ts`'s pre-walk paused guard (line 277-281), but the run command never gets the chance to render the right banner.
- **Suggested fix:** Add a `paused` arm before the failure `else` in `run.ts`. Concrete sketch (replace the structure at line 429-481):

  ```ts
  } else if (result.status === 'paused') {
    process.removeListener('SIGINT', sigintHandler);
    await progress.stop();
    await renderPausedBanner(
      flow.name,
      result.runId,
      result.runDir,
      flow.stepOrder,
      result.pausedStepId !== undefined ? { stepId: result.pausedStepId } : undefined,
    );
    maybeSendRunEvent({ ...; status: 'paused'; ... });  // add 'paused' to RunStatus union
    process.exit(EXIT_CODES.paused);  // 75
  } else if (result.status === 'aborted' && wasInterrupted) {
    // ... existing
  } else {
    // ... existing failure path
  }
  ```

  The `renderPausedBanner` already takes an optional `awaitingInput` parameter that flips the footer hint to `answer: relay answer <runId>` (`packages/cli/src/paused-banner.ts:192,209-211,235-237`), so the only wiring needed is the new branch and an additional `'paused'` value in the telemetry `status` enum (or omit telemetry for paused runs).

- **Decision:** fix now.

---

## FLAG · 6

### FLAG-1 · CLI duplicates `askAnswerHandoffKey` / answer-file path string instead of importing the helpers exported by core

- **File:** `packages/cli/src/commands/answer.ts:33-45`
- **Spec / decision:** From the task brief — "Two code paths know the conventional file layout — verify both paths use the shared `askAnswerHandoffPath(runDir, stepId)` helper, OR file an issue if the CLI duplicates the path string." Concern #1 from the briefing.
- **Finding:** Both `askAnswerHandoffKey(stepId)` and `askAnswerHandoffPath(runDir, stepId)` are exported from `@ganderbite/relay-core` (`packages/core/src/orchestrator/index.ts:2`, re-exported from the package root at `packages/core/src/index.ts:333-338`). The CLI does not import them; instead it redefines `askAnswerHandoffKey` (line 39-41) and re-derives the path via `join(runDir, 'handoffs', '${askAnswerHandoffKey(stepId)}.json')` (line 43-45) with a comment that points back at the core helper as the source of truth. This is exactly the kind of drift the public helpers were exported to prevent: a future change to the answer key shape (e.g. adding a hash, namespacing per question source) would have to touch both definitions or the CLI silently writes to the wrong path.
- **Suggested fix:** Remove the local `askAnswerHandoffKey` and `answerHandoffPath` helpers in `commands/answer.ts:33-45`; import the canonical pair instead:

  ```ts
  import {
    askAnswerHandoffKey,
    askAnswerHandoffPath,
    atomicWriteJson,
    loadState,
    Orchestrator,
    StateMachine,
    StateNotFoundError,
  } from "@ganderbite/relay-core";
  ```

  Then replace `answerHandoffPath(runDir, pausedStepId)` at line 302 with `askAnswerHandoffPath(runDir, pausedStepId)`. The existing CLI test at `packages/cli/tests/commands/answer.test.ts:196` only asserts `writtenPath.includes('__ask_gather__')` and `writtenPath.includes('handoffs')`, so the change requires no test edits.

- **Decision:** fix now.

### FLAG-2 · Ask step inside a `loop` body would crash the run rather than pause it cleanly

- **File:** `packages/core/src/flow/steps/loop.ts:50-52`, `packages/core/src/orchestrator/orchestrator.ts:1289-1318, 1462-1510`
- **Spec / decision:** Decision A enumerates `step.ask` as a kind. The loop body switch in `loop.ts:50-52` accepts `'ask'` as a body step kind, signalling that ask-in-loop is a supported configuration. There is no explicit decision against it in A-G.
- **Finding:** When an ask step lives inside a `loop` body, the loop dispatcher (`runBodyStep` at `orchestrator.ts:1331-1338`) calls `runExecutor(bodyStep, 1)`, which hits the `case 'ask'` arm and calls `executeAsk(step, ..., step.id, runDir)`. On the first pass `executeAsk` throws `AwaitingInputSignal(stepId, questions)` where `stepId` is the body step id. The signal bubbles up through `executeLoop` to `runExecutor` of the loop step to `dispatchStep` of the loop step. The catch at `orchestrator.ts:1462-1510` then calls `stateMachine.pauseStep(caught.stepId, ...)` with the **body step id**, but `state.json` has no entry for body step ids (loops only seed top-level step entries via `stateMachine.init`). `StateMachine.#requireStep` at `state.ts:452-458` returns `StateTransitionError("unknown step: <bodyStepId>")`. The error is logged at error level (`orchestrator.ts:1476-1483`) and pause-saving falls through to a `state.save()` call that does not actually persist the pause flip; the run status stays `'running'`, the ask step's bodyStep status stays nonexistent in state.json, and the walker eventually exits with no `paused` outcome wired up correctly. End result: ask-in-loop is silently broken.
- **Suggested fix:** Pick one of:
  1. Reject ask inside a loop body at compile time, similar to how `loop.ts:103-107` rejects `parallel`. Add at `loop.ts:108`:

     ```ts
     if (s.kind === "ask") {
       throw new FlowDefinitionError(
         "loop step body must not contain ask steps (step.ask inside a body is not supported in this version — pause/resume requires top-level state entries)",
       );
     }
     ```

     and remove the `case 'ask': return { ...raw, id };` at `loop.ts:50-52` so the union narrowing fails as well.

  2. Properly support it by surfacing the loop step id (not the body step id) on the `AwaitingInputSignal` carry, or by seeding body-step state entries on demand. Substantially more work and likely deferred.

  Option 1 is the safe sprint-46 choice; option 2 is a follow-up sprint task.

- **Decision:** fix later. option 2.

### FLAG-3 · `validateAskQuestionSources` shadows the loop-scoped check from `validateContextFrom` instead of sharing it — duplicated maintenance surface

- **File:** `packages/core/src/flow/graph.ts:508-588`
- **Spec / decision:** Code quality / maintainability. Not a correctness bug today.
- **Finding:** The new `validateAskQuestionSources` re-implements the producer map and the loop-body-handoff reverse lookup that `validateContextFrom` already builds (`graph.ts:391-421` vs `513-541`). Lines 513-525 and 391-403 are nearly identical; lines 530-541 and 410-421 are identical. A future change to either map's construction (e.g. allowing artifact-only steps to declare a handoff name, adding a third producer category) has to be applied in both places. Today both validators agree; tomorrow they could diverge silently.
- **Suggested fix:** Extract the producer map and loop-body-handoff reverse map into module-private helpers used by both validators:

  ```ts
  function buildProducerMaps(
    keys: readonly string[],
    stepMap: Map<string, Step>,
  ): {
    producers: Map<string, Set<string>>;
    loopBodyHandoffs: Map<string, string>;
  } {
    // ... shared body
  }
  ```

  Then `validateContextFrom` and `validateAskQuestionSources` both call `buildProducerMaps(keys, stepMap)` and operate on the result. Reduces ~30 lines of duplication and keeps producer semantics in one place.

- **Decision:** fix now.

### FLAG-4 · `state.json` paused-step state never migrates `attempts` correctly when the ask step pauses on a retry attempt

- **File:** `packages/core/src/state.ts:283-318` (`resumePausedStep`), `packages/core/src/state.ts:327-356` (`pauseStep`)
- **Spec / decision:** Decision E ("`'paused'` is added to `FlowStatus` and `StepStatus`"). Implicit constraint: the ask step's `attempts` counter should never grow on a pause-resume round-trip — pausing for input is not a retry.
- **Finding:** When an ask step is dispatched, `dispatchStep` calls `stateMachine.startStep(stepId)` which increments `attempts` (`state.ts:165-170`). On `AwaitingInputSignal`, `pauseStep` flips status to `'paused'` but **preserves** `attempts` at the incremented value (`state.ts:344-355`). On `relay answer`, `resumePausedStep` flips back to `'pending'` and **preserves** `attempts` (line 304-307). When the orchestrator re-dispatches on resume, `startStep` increments `attempts` again — so a single round-trip through pause-resume pushes `attempts` from 0 → 2 even though the step never failed. The maxRetries clamp at `orchestrator.ts:1431` (`remainingRetries = Math.max(0, maxRetries - priorAttempts)`) then clamps with `priorAttempts === 2`. Ask steps configure their retry budget via `stepRetryBudget` returning `{ maxRetries: 0, timeoutMs: undefined }` (`orchestrator.ts:1365`), so the clamp value is `Math.max(0, 0 - 2) === 0` — no retries allowed, which is fine. But the `attempts` field as recorded in state.json now overstates how many real attempts the step has had. If a future feature uses `attempts` for anything other than the retry-budget calculation (e.g. metrics, diagnostic output, doctor checks), the inflated count will be misleading.
- **Suggested fix:** In `resumePausedStep` (state.ts:303-307), reset `attempts: 0` instead of preserving the prior value, since a pause-resume is not a retry:

  ```ts
  const next: StepState = {
    status: "pending",
    attempts: 0, // pause/resume is not a retry — startStep on next dispatch will set attempts=1
  };
  ```

  Or alternatively decrement by 1 to preserve the invariant that `attempts` counts dispatches that actually ran an executor. Either choice should land with a unit test in `state.test.ts` that asserts the field after a pause-resume round-trip.

- **Decision:** fix now. decrement by 1.

### FLAG-5 · `relay answer` interactive prompt rendering inlines symbols and color helpers but does not use the brand vocabulary consistently

- **File:** `packages/cli/src/commands/answer.ts:55-150` (interactive prompts), `94, 106, 121, 126`
- **Spec / decision:** Brand grammar — "Symbol vocabulary must come from `visual.ts`" / `brand.ts`. Specifically the bullet (`·`), pending dot (`○`), and similar should be sourced from `SYMBOLS`.
- **Finding:** The interactive question rendering (`promptText`, `askQuestion`) writes plain ` ${q.label}:` for text/multiline (line 57), `  ${q.label}\n` followed by `    ${i + 1}. ${opt}\n` for select/multiselect (lines 103, 105). These match nothing in `SYMBOLS` from `brand.ts` — they're plain ASCII and Arabic numerals. That is fine in itself (the brand vocabulary doesn't mandate a particular rendering for question labels), but the inconsistent indentation (`  ` vs `    `) and the lack of any visual marker that shows "this is a question to answer" (vs the rest of the CLI's output) makes the prompt feel disconnected from Relay's voice. The error/help lines correctly use `red()`, `gray()`, `SYMBOLS.fail`, `SYMBOLS.warn`. The question prompts themselves are silent.
- **Suggested fix:** Either (a) accept the current minimal styling as the deliberate prompt aesthetic and move on, or (b) prefix each question with `SYMBOLS.dot` (`·`) or similar:

  ```ts
  process.stdout.write(`${SYMBOLS.dot} ${q.label}\n`);
  ```

  No spec mandate forces option (b); call this a polish item only if the brand owner has an opinion.

- **Decision:** fix now. option (b).

### FLAG-6 · Unused `terminalStep` import in `tests/flow/ask.test.ts`

- **File:** `packages/core/tests/flow/ask.test.ts:11`
- **Spec / decision:** Concern #3 from the briefing; lint hygiene.
- **Finding:** `import { terminalStep } from '../../src/flow/steps/terminal.js';` is the only `terminalStep` reference in the file. Tests at line 303 and line 333 build terminal steps inline as object literals (`{ id: 'root', kind: 'terminal' } satisfies Step`) so the imported builder is never invoked. The lint hook flagged this during the wave-5 commit; it remains in the codebase.
- **Suggested fix:** Delete line 11 (`import { terminalStep } from '../../src/flow/steps/terminal.js';`). One-line change, no test behaviour impact.
- **Decision:** fix now.

---

## PASS · 18 (no action needed)

- `packages/core/src/flow/question.ts`: complete `Question` discriminated union with all 6 kinds, native Zod v4 `z.discriminatedUnion`, type aliases inferred via `z.infer<>`, no third-party schema libraries.
- `packages/core/src/flow/types.ts`: `'ask'` added to `StepKind`, `'paused'` added to `FlowStatus` and `StepStatus`, `AskStepSpec` and `AwaitingInput` interfaces match the task brief shape exactly.
- `packages/core/src/flow/schemas.ts`: `askStepSpecSchema` uses `z.union([QuestionsArraySchema, DynamicQuestionSourceSchema])` and proper `zodSchemaValue` for `output.schema`.
- `packages/core/src/flow/steps/ask.ts`: builder validates via `safeParse` and throws `FlowDefinitionError` via `toFlowDefError`, mirroring the canonical prompt builder pattern.
- `packages/core/src/flow/define.ts`: `synthesizeStep` covers `'ask'` exhaustively in the kind switch.
- `packages/core/src/flow/graph.ts`: `validateAskQuestionSources` validates dynamic question sources against the same loop-scope rules as `validateContextFrom`; `handoffNameOf` returns `step.id` for ask steps so downstream `contextFrom` resolution works.
- `packages/core/src/state.ts`: `pauseStep` and `resumePausedStep` are pure in-memory transitions with explicit guards; the `awaitingInput` field is properly cleared when the paused step resumes.
- `packages/core/src/errors.ts`: `AwaitingInputSignal` is documented as an internal control-flow signal, carries `stepId` and `questions`, extends `Error` (not `PipelineError`) so it does not leak into the typed Result hierarchy.
- `packages/core/src/orchestrator/orchestrator.ts`: ask kind handled in the dispatch switch with explicit pause cascade — `pauseStep` → `save()` → `abortController.abort()` → re-throw signal. The walker's completion drain skips `firstError` tracking when `pausedSignal !== undefined` so the originating pause is the surfaced outcome.
- `packages/core/src/orchestrator/orchestrator.ts`: paused runs skip the `markRun(runStatus)` pass at lines 420-423 / 698-701 to avoid clobbering the in-walker pause flip.
- `packages/core/src/orchestrator/exec/ask.ts`: clean two-path implementation (resume reads via low-level `readFile`, first-pass throws `AwaitingInputSignal`); ENOENT correctly distinguished from other I/O errors; dynamic question source goes through `HandoffStore.read` so a malformed producer surfaces as `HandoffSchemaError`.
- `packages/core/src/orchestrator/exec/parallel.ts`: `BranchStatusSnapshot` extended with `'paused'` so the parallel executor can describe a branch that paused for input without conflating it with running/failed.
- `packages/core/src/orchestrator/resume.ts`: `seedReadyQueueForResume` includes paused steps (status check excludes only `'succeeded'` and `'skipped'`) and the resume sweep at `orchestrator.ts:592-595` calls `resumePausedStep` before the walker dispatches.
- `packages/core/src/orchestrator/index.ts`: re-exports `askAnswerHandoffKey` and `askAnswerHandoffPath` so the CLI can share the convention (FLAG-1 notes the CLI doesn't actually use them yet).
- `packages/cli/src/commands/resume.ts`: the paused-run guard at lines 277-281 prints the brand-correct warning + hint + exit 1 before any orchestrator work, exactly matching the task brief.
- `packages/cli/src/exit-codes.ts`: `EXIT_CODES.paused = 75` added with a docstring explaining its meaning.
- `packages/cli/src/paused-banner.ts`: `awaitingInput` parameter flips the footer hint from `resume: relay resume <runId>` to `answer: relay answer <runId>`, both in the minimal-fallback path and the full-banner path; paused step renders as `· <name>  awaiting input`.
- `packages/generator/templates/interactive/{flow.ts,prompts/01_execute.md,README.md,package.json,tsconfig.json}`: complete two-step interactive flow demonstrating both static questions and downstream `contextFrom` consumption; README documents the pause-then-answer UX without emojis or banned words.

---

## Other follow-ups (out of sprint-46 scope)

- `packages/cli/src/commands/resume.ts:5,103,405` and `packages/cli/src/paused-banner.ts:8` carry pre-existing `§6.7` / `§11.5` spec references in code comments. Memory rule says comments must be self-contained — these predate sprint 46 (verified with `git blame`). Worth a cleanup pass in a future docs/maintenance sprint.
- `packages/core/tests/orchestrator/orchestrator.test.ts` — `[ABORT-001]` and `[ABORT-002]` are flaky on the baseline (one fails with `ENOTEMPTY: directory not empty, rmdir '...live'`, the other times out at 10s). `packages/core/tests/orchestrator/state-save-failure.test.ts` — `rejects with StateWriteError when the step startSave fails and does not hang` times out at 5s. Confirmed by `git log --oneline 3fe702b..HEAD -- <these test files>` returning empty; sprint 46 did not touch any of them. Out of scope for this review; tracked separately under the existing flake remediation effort.
- `packages/core/src/flow/define.ts` and `packages/core/src/flow/graph.ts` re-implement step-kind exhaustive switches in three different places (`define.ts:42-58`, `loop.ts:39-53`, `graph.ts:128`). Adding a new step kind in the future requires touching all three. A consolidated `STEP_KIND_HANDLERS` table or a single `synthesizeStep` helper shared across `define.ts` and `loop.ts` would localise this. Independent of sprint 46.
- The orchestrator's `paused` status surfacing requires the embedding host to handle it explicitly — the BLOCK on `relay run` is the most obvious case, but the embedded `onStepComplete` API also doesn't fire for ask steps that pause (the pause path returns the `AskStepResult` from the resume pass only). Embedding host integrators (IDE plugins, dashboards) will need a separate `onStepPaused` lifecycle hook in a follow-up. Not a sprint-46 deliverable.
