# Sprint 50 · Hardening — docs, UX, tests, logger centralization — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `ebd92b5` (feat: document architecture, add load and resilience tests, improve CLI UX)
- `c5acfa8` (chore(cli): add 400-line file cap lint check for CLI source files)

**Summary:** 0 BLOCK, 7 FLAG, 14 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Section A — Docs and conventions (task_143, task_144, task_146)

### FLAG-1 · `ARCHITECTURE.md` Orchestrator section is missing the `ask` and `terminal` executors

- **File:** `packages/core/src/ARCHITECTURE.md:81-85`
- **Spec:** task_143 — "Adding a new step kind" section must accurately list the surfaces an author updates. The doc says step-registrations.ts registers "seven built-in step kinds" (line 75) but only lists five executors in the table.
- **Finding:** `packages/core/src/orchestrator/exec/` contains seven step-kind executors — `ask.ts`, `branch.ts`, `loop.ts`, `parallel.ts`, `prompt.ts`, `script.ts`, `terminal.ts` — but the Orchestrator table in ARCHITECTURE.md only lists prompt / script / branch / parallel / loop. A new contributor reading the table would not realise that `ask` and `terminal` are also live step kinds with their own executors, even though their builders are correctly listed under "Flow DSL". The internal inconsistency between "seven built-in step kinds" (line 75) and the five-row executor table (lines 81–85) is the symptom.
- **Suggested fix:** Add two rows to the Orchestrator/Executor block:
  - ``| `orchestrator/exec/ask.ts` | Executor for `ask` steps — pauses the run and writes the pending Question set. |``
  - ``| `orchestrator/exec/terminal.ts` | Executor for `terminal` steps — spawns an interactive shell session. |``
    Total file size goes from 119 → 121 lines, which crosses the stated ≤120 cap; drop the empty trailing line or move one of the prose paragraphs onto a shorter line to stay at 120.
- **Decision:** fix now.

### FLAG-2 · CLAUDE.md Hard rule 8 cites a CLI file that is part of a layered `progress/` module

- **File:** `CLAUDE.md:78`
- **Spec:** task_144 — the rule must list every CLI surface an author touches when adding a step kind.
- **Finding:** Rule 8 names `packages/cli/src/progress/render.ts` as the place to update. That file exists, but the actual progress system has a wider surface — `progress/index.ts`, `progress/step-row.ts`, and the dispatcher live in the same directory and may also need per-kind hooks depending on the kind. The current single-file pointer underspecifies. Either tighten the rule to "`packages/cli/src/progress/`" so readers know to scan the directory, or list all the per-step rendering files. Note this is forward-looking — the rule fires only when _adding_ a step kind, which is rare, so the risk of a misled author is low.
- **Suggested fix:** Change the path from `packages/cli/src/progress/render.ts` to `packages/cli/src/progress/` (directory, not file), e.g. "check the `progress/` rendering tree (per-step row, status formatter) and `banner.ts` (distinct success/failure row shape)".
- **Decision:** fix now.

### FLAG-3 · Both wave commit messages include sprint-internal `task_N` identifiers in the body

- **File:** commits `ebd92b5` and `c5acfa8`
- **Spec:** `CLAUDE.md:87-92` — "Commit subjects and bodies MUST NOT contain sprint-internal identifiers: `task_N` — use only in sprint JSON and code review artifacts."
- **Finding:** Both commit bodies enumerate `task_143`, `task_144`, `task_145`, `task_146`, `task_147`, `task_148`, `task_149`, `task_150` and end with `Closes task_X from _work/sprint-50.json`. The convention forbids this. The rule was added to CLAUDE.md before sprint 50 began (see prior sprint commits) and was reinforced in sprint 49 reviews. Because the rule is already documented and these are the first sprint commits authored after the rule landed, the violation is fresh — worth flagging so the orchestrator can decide whether to amend or simply learn for sprint 51.
- **Suggested fix:** Drop the `task_X` prefixes and the `Closes task_X` trailers from future commits. Rewrite the body as a flat bullet list of what changed, e.g. "add packages/core/src/ARCHITECTURE.md with module map …", "document throw-vs-Result discipline in CLAUDE.md", and so on. History rewrite for the two existing commits is destructive and probably not worth it for two messages — note for future sprints instead.
- **Decision:** fix now.

---

## Section B — UX improvements (task_145, task_146)

### FLAG-4 · `check-file-lengths.ts` SHIM_EXEMPTIONS list is hardcoded with one entry — fragile as new shims appear

- **File:** `packages/cli/scripts/check-file-lengths.ts:11-13`
- **Spec:** task_146 — "thin re-export shim exemption mechanism". The script currently hardcodes a single entry (`src/progress.ts`) and provides no programmatic detection.
- **Finding:** The exemption is a hand-maintained Set. Any future re-export shim (e.g. `exit-codes.ts` itself is a 10-line shim today and is _not_ exempted but stays under the 400-line cap so the issue is latent) will need a manual edit to this file. A simple heuristic — "file is exempt if every non-empty, non-comment line is `export ... from '...';`" — would auto-detect shims and prevent future drift. Not a blocker because the current cap is generous enough to make this a non-issue for genuine shims (which are tiny). Worth tracking for the day someone adds a 401-line shim.
- **Suggested fix:** Either (a) leave the Set in place and rely on the cap being roomy, or (b) replace `isShimExempt` with a content-scanning predicate: read the file, strip comments and blank lines, and exempt when every remaining line matches `/^\s*export\s+(\{[^}]*\}|\*)\s+from\s+['"][^'"]+['"];?\s*$/`. Option (b) is preferred because it eliminates the hardcoded list entirely.
- **Decision:** fix now. option (b)

### FLAG-5 · `check-file-lengths.ts` counts lines by splitting on `'\n'`, which over-counts files ending with a newline

- **File:** `packages/cli/scripts/check-file-lengths.ts:29-32`
- **Spec:** Code quality / correctness.
- **Finding:** `content.split('\n').length` returns N+1 for a file with N lines terminated by a trailing newline (the canonical POSIX shape). A 400-line file ending with `\n` reports as 401 and trips the cap. The script reports 7 violations today, and the largest (lint.ts at 571) is comfortably over the cap, so no false positive surfaces — but a borderline file at exactly 400 written by a developer who runs prettier could land at 401 and unexpectedly fail the check. The fix is one line.
- **Suggested fix:** Replace lines 29–32 with:
  ```ts
  function countLines(filePath: string): number {
    const content = readFileSync(filePath, "utf8");
    if (content === "") return 0;
    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  }
  ```
  Or use `content.match(/\n/g)?.length ?? 0` plus a +1 if the file is non-empty and does not end with `\n`. The first form is clearer.
- **Decision:** fix now.

### FLAG-6 · `program.showSuggestionAfterError(true)` is wired but no smoke test asserts the message shape

- **File:** `packages/cli/src/dispatcher.ts:91-92`
- **Spec:** task_145 — "show did-you-mean suggestions for mistyped commands".
- **Finding:** The call sits at the right place (after `exitOverride()`, before any commands are registered) so suggestions will fire on unknown subcommands. There is no test that asserts what the user sees — `relay rsume` (typo for `resume`) should print Commander's default `error: unknown command 'rsume'. Did you mean 'resume'?` to stderr. Without a smoke test, a future Commander upgrade or a wholesale dispatcher refactor could silently drop the suggestion. The risk is low because it is one line, but a snapshot test in `packages/cli/tests/` would lock the behaviour in.
- **Suggested fix:** Add a test in `packages/cli/tests/dispatcher.test.ts` (or wherever the CLI smoke tests live) that runs `buildProgram().parseAsync(['node', 'relay', 'rsume'], { from: 'user' })` inside a try/catch, captures stderr via vi.spyOn, and asserts the stderr text contains `Did you mean 'resume'?`. Defer if the CLI test harness does not already capture commander stderr.
- **Decision:** fix now.

---

## Section C — Tests (task_147, task_148, task_149)

### FLAG-7 · Cross-process and corrupt-flow-ref tests depend on `packages/core/dist/index.js` existing — fragile when run locally without `pnpm build`

- **File:** `packages/core/tests/integration/cross-process-handoff.test.ts:33`, `packages/core/tests/integration/fixtures/crash-test-flow.ts:14`
- **Spec:** task_148 acceptance criteria — "child resolution strategy". The agent self-flagged this risk in the task brief.
- **Finding:** The cross-process test hardcodes `DIST_INDEX = resolve(__dirname, '../../dist/index.js')` and writes a shim that imports from that absolute path. The corrupt-flow-ref fixture imports from `@ganderbite/relay-core` which resolves to the same dist bundle (via the workspace package's `exports.import`). Running `pnpm -F @ganderbite/relay-core test` cold (no prior build) will fail both suites with `Cannot find module …/dist/index.js`. CI is safe because `.github/workflows/ci.yml` runs `pnpm -r build` (line 64) before `pnpm test` (line 68), so this is a local-dev-only paper cut. Documenting the prerequisite in the test file or in a README is enough.
- **Suggested fix:** Either (a) add a top-of-file comment in both tests stating "Run `pnpm -F @ganderbite/relay-core build` before this suite — it imports from the built dist for cross-process and fixture isolation reasons", or (b) add a `pretest` script in `packages/core/package.json` that runs `tsup` so the build is implicit. Option (b) trades developer-loop speed (rebuild every test run) for ergonomics, so prefer (a) unless someone hits this often.
- **Decision:** fix now. option (a)

### FLAG-8 · Load test 4 ("10-step DAG produces correct handoffs") relies on the vitest default 10s timeout

- **File:** `packages/core/tests/load/load.test.ts:227`
- **Spec:** task_147 — "wall-clock thresholds conservative".
- **Finding:** The first three load tests set explicit timeouts (120 000 ms, 60 000 ms, 20 000 ms). The fourth case ("10-step DAG produces correct handoffs") does not — it falls back to the vitest config default of 10 000 ms (from `packages/core/vitest.config.ts:8`). Ten serial prompt steps with atomic state.json writes complete well under 10 s on a fast machine, but a cold Vitest worker on a constrained CI runner might brush the edge. The test is also the only one that asserts correctness rather than time, so flaking it would be a regression in observability.
- **Suggested fix:** Add `{ timeout: 30_000 }` to the third `it(...)` argument: `it('10-step DAG produces correct handoffs', { timeout: 30_000 }, async () => {`. Keeps the load suite consistent and gives 30s headroom for cold CI.
- **Decision:** fix now.

### FLAG-9 · `GuardProvider` in corrupt-flow-ref test throws from `invoke` and `stream` — violates the Provider Result-discipline contract

- **File:** `packages/core/tests/integration/corrupt-flow-ref.test.ts:61-73`
- **Spec:** Project convention (Memory: "Return Result via neverthrow, do not throw"). The `Provider.invoke` signature is `Promise<Result<InvocationResponse, PipelineError>>` — throws cross the public API surface.
- **Finding:** The test asserts that neither `invoke` nor `stream` is reached (because resume fails before any step dispatch). The current GuardProvider raises a bare `Error` from both. If the test ever regresses and the orchestrator does invoke a step, the thrown error will surface as an unhandled rejection rather than as a typed test failure — and more importantly, it sets a bad pattern for future tests that imitate this. The Provider interface promise is that fallible operations return `err(...)`, and a "loud" guard provider can still honour that by returning `err(new PipelineError('invoke must not be called', ERROR_CODES.INTERNAL, { stepId }))`.
- **Suggested fix:** Change line 64-66 to `return err(new PipelineError(\`invoke must not be called — got stepId "\${ctx.stepId}"\`, ERROR_CODES.INTERNAL, { stepId: ctx.stepId }));`and import`err`from neverthrow plus`PipelineError`. For `stream` (which returns AsyncIterable, not Result), throw is the only option since there is no error channel; leave it. Minor — purely about future-proofing test patterns.
- **Decision:** fix now.

---

## Section D — Logger centralization (task_150)

(No findings — task was correctly identified as a no-op. Both verification claims confirm.)

---

## PASS · 14 (no action needed)

- `packages/core/src/ARCHITECTURE.md`: 119 lines, no emojis, no banned words; every file path in the Foundation, Flow DSL (DSL builders), Flow DSL (graph), Orchestrator (core), Providers, and Settings/Testing tables corresponds to a real file on disk; "Read these first" entries and the "Adding a new step kind" / "Adding a new provider" sections are accurate against the live registry pattern.
- `CLAUDE.md`: Hard rules 7, 8, 9 appended cleanly to the existing list without reordering. All cited paths (`packages/core/src/orchestrator/exec/`, `step-registrations.ts`, `progress/render.ts`, `banner.ts`) exist. Rule 7 correctly distinguishes public API neverthrow discipline from internal executor throws — matches the codebase's actual contract.
- `packages/cli/src/dispatcher.ts`: `showSuggestionAfterError(true)` placed inside `buildProgram()` after `exitOverride()` and before any command is registered, so suggestions apply for every mistyped subcommand at parse time.
- `packages/cli/src/commands/resume.ts`: previously-raw `flowResult.error.message` render at step (4) now uses `formatError(flowResult.error)` + `process.exit(exitCodeFor(flowResult.error))`. Adjacent usage-error paths (StateNotFoundError, malformed flow-ref.json) keep raw `.message` rendering with `// usage-error: formatError does not apply` comments — consistent with the project's typed-vs-usage error convention.
- `packages/cli/src/commands/run.ts` / `dry-run.ts` / `validate.ts`: spot-checked — all three route their `loadResult.isErr()` paths through `formatError` + a definition-error-aware exit code. No remaining raw `.message` on flow-load failures.
- `packages/cli/src/commands/answer.ts`: every raw `.message` site is annotated with `// usage-error: formatError does not apply` and the reason — auditable.
- `packages/cli/scripts/check-file-lengths.ts`: walks `src/`, skips `node_modules` and `dist`, exits 1 on violations and 0 on clean, no emojis or trailing exclamation marks in either output branch. Verified the script runs and produces the same 7-file violation list quoted in the commit body (lint.ts 571, logs.ts 532, resume.ts 462, install.ts 459, run.ts 441, registry.ts 411, input-parser.ts 405).
- `packages/cli/package.json`: `lint:filesize` script added under scripts; `tsx ^4.8.1` added under devDependencies. Matches the script's `node --import tsx/esm` runner.
- `packages/core/tests/load/load.test.ts`: MockProvider only — no live Claude calls; four test cases (100-step linear, 50-iteration loop, 10-branch parallel, 10-step correctness); temp dirs cleaned up in afterEach; silent logger used so per-step log I/O does not pollute timings. The loop test asserts `callCount === 50`, confirming the `until` exit triggers on the 50th iteration (not on iteration 1).
- `packages/core/tests/integration/cross-process-handoff.test.ts`: spawns 10 concurrent child writers across 3 race iterations; checks both winner-payload validity and absence of leaked `.tmp-*` files in the temp dir; uses an absolute path to the pre-built dist (a known fragility — see FLAG-7); afterEach cleanup.
- `packages/core/tests/integration/corrupt-flow-ref.test.ts`: three test cases. The corrupt-JSON path correctly asserts the orchestrator-wrapped `PipelineError` with `code === STATE_NOT_FOUND` (matches `packages/core/src/orchestrator/orchestrator.ts:142-148`); the missing-file path correctly asserts `FlowImportError` with `details.reason === 'absent'` (matches `packages/core/src/orchestrator/resume.ts:98-102` and the `FlowImportDetails.reason` union in `errors.ts:116`).
- Logger centralization (task_150): `grep -rn 'createLogger' packages/core/src/orchestrator/exec/` returns zero hits. `packages/core/src/orchestrator/step-dispatch-context.ts:40` declares `logger: Logger` on the context. Orchestrator's `#buildLogger` is the sole construction site. The no-op claim is correct.
- Brand grammar / banned words: no emojis introduced in any new file. The word "simply" appears only in `CLAUDE.md:72` (the rule itself, quoting the ban). No trailing exclamation marks in any new user-visible output string.
- ESM and self-contained comments: all new TypeScript files use ESM imports with `.js` extensions; all code comments are self-contained (no spec refs `§…`, no `task_N` / `FLAG-N` / `BLOCK-N` IDs).

---

## Other follow-ups (out of sprint-50 scope)

- The 7 pre-existing CLI file-length violations (`lint.ts` 571, `logs.ts` 532, `resume.ts` 462, `install.ts` 459, `run.ts` 441, `registry.ts` 411, `input-parser.ts` 405) need a dedicated split sprint before `lint:filesize` can be promoted to fail-on-merge in CI. The commit body already calls this out.
- `vitest.config.ts` in `packages/core` sets a 10-second default test timeout. Several integration tests now override it case-by-case; consider raising the default to 15–20s globally to remove the boilerplate from every long test.
- The `progress/` rendering tree has grown enough that a per-step-kind dispatcher might be worth extracting — would let the new Hard rule 8 in CLAUDE.md narrow to a single file pointer.
