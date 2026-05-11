# Sprint 51 · step.ask defect fixes — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `50ae762` (fix(cli): register providers in answer and forward --verbose in resume)
- `2330cbe` (fix(cli): render full paused banner on multi-ask re-pause in answer)
- `1d54426` (fix(cli): prompt inline for answers in foreground TTY on pause)
- `fa44dcd` (test(cli): regression coverage for the four step.ask defect fixes)

**Summary:** 0 BLOCK, 4 FLAG, 14 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Section A — Defect 1: provider registration in `relay answer`

### A.1 — `registerDefaultProviders()` is called before `Orchestrator.resume()` — **PASS**

- `packages/cli/src/commands/answer.ts:286` calls `registerDefaultProviders()` after flow-ref load and before the auth guard. The orchestrator is constructed at line 437 and `resume()` invoked at line 444, both strictly downstream of the provider registration.
- The registration is imported from `@ganderbite/relay-core` at line 35 alongside the other core symbols — no risk of a stale import.
- The mock in `packages/cli/tests/commands/answer.test.ts:50` replaces `registerDefaultProviders` and test `[A1]` (line 490-497) explicitly asserts `mockRegisterDefaultProviders` is called before `mockOrchestratorResume`.
- **Decision:**

### A.2 — Auth failure surfaces `formatError` + `exitCodeFor(authResult.error)` — **PASS**

- `packages/cli/src/commands/answer.ts:288-294` runs `authenticateProvider({ flowDir: dirname(flowRef.flowPath) })` and on `isErr()` writes `formatError(authResult.error)` to stderr then exits with `exitCodeFor(authResult.error)`. This mirrors the resume.ts auth path at lines 341-348 and satisfies the billing-safety contract: a `SubscriptionAuthError` would map to exit code 3 via the registry at `packages/cli/src/errors/registry.ts:191-193`, not get swallowed.
- Test `[A3]` (`answer.test.ts:514-526`) asserts `process.exit(3)` is called and the orchestrator is never invoked when `authenticateProvider` returns an error.
- `flowDir` is correctly derived from the persisted `flowPath` (line 289 — `dirname(flowRef.flowPath)`), so per-flow `settings.json` is honoured the same way as `relay resume`.
- **Decision:**

### A.3 — `preAuthedState` is wired as a `Map<string, AuthState>` with one entry — **PASS**

- `packages/cli/src/commands/answer.ts:439-440` builds `const preAuthedMap = new Map<string, AuthState>(); preAuthedMap.set(resolvedProvider.name, authState);` and passes it via `orchestrator.resume(runDir, { logToStdout: ..., preAuthedState: preAuthedMap })` at lines 444-447.
- Map key is the provider name (`resolvedProvider.name`), matching the orchestrator's lookup convention in resume.ts:402-403 — the orchestrator can find the cached AuthState by name and skip re-authentication.
- Test `[A2]` (`answer.test.ts:499-512`) asserts `resumeOptions.preAuthedState` is `instanceOf(Map)` with `size === 1`.
- **Decision:**

### A.4 — `flow-ref.json` missing or malformed exits cleanly with exit 1 — **PASS**

- `packages/cli/src/commands/answer.ts:244-271` wraps the `readFile + JSON.parse + shape check` in a try/catch. ENOENT, parse error, and shape mismatch all funnel to the same error block (lines 263-271) which writes a red error line then `process.exit(1)`.
- The `flowRef.flowPath === null` guard at line 273-277 catches the case where the persisted JSON is well-formed but `flowPath` is absent.
- Test `[RES-015]` and `[RES-016]` in `resume.test.ts` exercise the parallel cases for `relay resume`; the answer command's parsing block is byte-identical. No dedicated answer.ts test for malformed flow-ref, but the path is structurally proven by the resume tests since the code is shared.
- **Decision:**

### A.5 — `§8.1` spec reference in source comment violates self-contained code-comment rule — **FLAG-1**

- **File:** `packages/cli/src/commands/answer.ts:279-285`
- **Spec / decision:** Code-comment self-containment rule (CLAUDE.md and `feedback_code_comments.md`): "no spec refs (§4.2, etc.), no sprint/task IDs in TS/JS docs or inline comments; commit messages and sprint JSONs carry that traceability."
- **Finding:** The block comment introducing the auth guard reads:

  ```
  // registerDefaultProviders() populates the defaultRegistry that executeRun
  // reads from; authenticateProvider() runs the §8.1 billing-safety guard
  // before any tokens can be spent. We forward the resulting AuthState into
  // orchestrator.resume() via preAuthedState so the orchestrator does not
  // re-authenticate (and so the user is not prompted twice for a passphrase
  // on subscription auth).
  ```

  Line 281 carries an inline `§8.1` reference. This is the only new spec-ref hit across all six sprint-51-touched files (verified via `grep -nE '§[0-9]'`); the rest of the codebase is clean.
- **Suggested fix:** Drop the section number, keep the human-readable phrase:
  ```ts
  // registerDefaultProviders() populates the defaultRegistry that executeRun
  // reads from; authenticateProvider() runs the billing-safety guard before
  // any tokens can be spent. We forward the resulting AuthState into
  // orchestrator.resume() via preAuthedState so the orchestrator does not
  // re-authenticate (and so the user is not prompted twice for a passphrase
  // on subscription auth).
  ```
- **Decision:**

---

## Section B — Defect 2: multi-ask banner UX in `relay answer`

### B.1 — Re-pause renders the full paused banner via `renderPausedBanner` — **PASS**

- `packages/cli/src/commands/answer.ts:449-456` handles the `result.status === 'paused'` branch by:
  1. Extracting `nextStepId = result.pausedStepId ?? 'unknown'`.
  2. Loading the flow via `loadFlow(flowRef.flowPath, process.cwd())` and reading `flow.graph.topoOrder` (falls back to `[]` on load failure).
  3. Calling `renderPausedBanner(state.flowName, runId, runDir, topoOrder, { stepId: nextStepId })`.
  4. Setting `exitCode = EXIT_CODES.paused` (= 75).
- The legacy plain yellow `run paused again at step ...` / gray `provide answers with: relay answer ...` lines from the prior implementation are removed (verified against the diff at `git diff 50ae762~1..HEAD -- packages/cli/src/commands/answer.ts` — the old `yellow(... SYMBOLS.warn} run paused again at step ${nextStepId})` and `gray(... provide answers with: relay answer ...)` lines are deleted).
- Test `[B1]` (`answer.test.ts:534-565`) asserts:
  - `mockRenderPausedBanner` is called once.
  - The 5th positional argument (`awaitingInput`) carries `{ stepId: 'step2' }`.
  - `process.exit(75)` is invoked.
  - Old plain-text strings (`paused again`, `relay answer run-abc`) do NOT appear on stdout.
- **Decision:**

### B.2 — `awaitingInput` argument shape on `renderPausedBanner` call — **PASS**

- The 5th argument to `renderPausedBanner` is `{ stepId: nextStepId }` (literal object form), matching the public signature at `packages/cli/src/paused-banner.ts:187-193`:
  ```ts
  export async function renderPausedBanner(
    flowName: string,
    runId: string,
    runDir: string,
    stepOrder: readonly string[],
    awaitingInput?: { stepId: string },
  ): Promise<void>
  ```
- The banner uses the presence of `awaitingInput` to switch the footer hint from `resume: relay resume <runId>` to `answer: relay answer <runId>` (paused-banner.ts:208-211). The re-pause case is the intended trigger.
- **Decision:**

### B.3 — `state.flowName` vs `flowRef.flowName` consistency on banner call — **PASS**

- The banner call at line 455 uses `state.flowName`. `state.flowName` is read from `state.json` (line 222: `const state: RunState = stateResult.value`), and `flowRef.flowName` is read from `flow-ref.json`. Both are written by the same `Orchestrator.run()` bootstrap when the run was first created, so they are equal by construction. Using `state.flowName` here is acceptable — no drift risk.
- **Decision:**

---

## Section C — Defect 3: inline answer in foreground TTY on pause

### C.1 — `run.ts` `result.status === 'paused'` branch guards on `process.stdout.isTTY` — **PASS**

- `packages/cli/src/commands/run.ts:348-366` implements the paused branch:
  - `if (process.stdout.isTTY)`: print `paused for input — answering inline` hint, dynamically `import('./answer.js')`, await `answerCommand([result.runId], {})`, and `return` (no `process.exit`).
  - Otherwise: render the paused banner and `process.exit(EXIT_CODES.paused)` (= 75).
- The non-TTY exit-75 path is preserved exactly (line 366) for scripted callers / CI.
- Test `[C1]` (`run.test.ts:293-311`) asserts inline answer is called on TTY and `process.exit(75)` is NOT called.
- Test `[C2]` (`run.test.ts:313-326`) asserts exit 75 on non-TTY and `mockAnswerCommand` is NOT called.
- TTY state is restored via `Object.defineProperty(process.stdout, 'isTTY', ...)` in `afterEach` (`run.test.ts:284-291`).
- **Decision:**

### C.2 — `resume.ts` adds the same paused-result branch — **PASS**

- `packages/cli/src/commands/resume.ts:437-454` adds the missing branch between `succeeded` and `aborted && wasInterrupted`. Same shape as run.ts:
  - TTY: dynamic import + delegate to `answerCommand([runId], {})` and `return`.
  - Non-TTY: `renderPausedBanner(flowRef.flowName, runId, runDir, [...flow.graph.topoOrder], result.pausedStepId !== undefined ? { stepId: result.pausedStepId } : undefined)` then `process.exit(EXIT_CODES.paused)`.
- Tests `[C3]` and `[C4]` (`resume.test.ts:403-460`) cover both branches. Test `[C4]` explicitly stubs `process.exit` to a no-op so the `try`-block `exit(75)` is not re-mapped to `exit(1)` by the outer catch — a careful piece of test plumbing that locks the contract.
- **Decision:**

### C.3 — Dynamic `import('./answer.js')` resolution under the tsup bundle — **PASS** (with note)

- Both `run.ts:355` and `resume.ts:443` use `const { default: answerCommand } = await import('./answer.js');` — a static string literal relative to the source file. Inside the compiled bundle, esbuild + tsup with `splitting: true` (see `packages/cli/tsup.config.ts`) analyses the literal and emits the import as a lazy split-chunk under `dist/answer-<hash>.js`. The existing dispatcher pattern (`packages/cli/src/dispatcher.ts:66`: `answer: () => import('./commands/answer.js')`) proves the bundler resolves the same shape correctly.
- Note: the prior implementation in run.ts (line 75) used `new URL('./resume.js', import.meta.url).pathname` for the inverse direction (run → resume) as a workaround for type-system concerns when the resume module did not yet exist. That older pattern is fragile on Windows because `URL.pathname` returns `/C:/...` form which is not a valid Node import specifier. The new inline-answer pattern with a bare relative import is cleaner and consistent with dispatcher.ts. Consider migrating the older `new URL(...).pathname` site in run.ts:75 to the same bare-import form in a future cleanup; not in scope for sprint 51.
- **Decision:**

### C.4 — Inline-answer hint string follows brand grammar — **PASS**

- Both run.ts:354 and resume.ts:442 emit `  ${SYMBOLS.dot} paused for input — answering inline\n`. The leading two spaces match the indent convention used by other status lines (e.g. `${SYMBOLS.ok} run ${runId} completed` in answer.ts:458). The em-dash separator and lowercase phrasing match the linear/loop README examples. No trailing exclamation, no banned words.
- **Decision:**

### C.5 — TTY check uses `process.stdout.isTTY` consistently — **FLAG-2**

- **File:** `packages/cli/src/commands/run.ts:353`, `packages/cli/src/commands/resume.ts:441`
- **Spec / decision:** Code quality / robustness. A pause prompt requires interactive **input** from stdin, not just an interactive output stream.
- **Finding:** Both branches gate on `process.stdout.isTTY`. The readline prompt that `answerCommand` opens reads from `process.stdin` (see `answer.ts:61`: `createInterface({ input: process.stdin, output: process.stdout })`). The two streams can disagree — for example `relay run … 2>&1 | tee out.log` redirects stdout to a pipe (`stdout.isTTY === false`, exit 75 path taken — correct), but `relay run … < /dev/null` keeps stdout on a TTY (`stdout.isTTY === true`) while stdin is a pipe (`stdin.isTTY === false`). In that second case the inline-answer branch fires and the readline prompt receives EOF immediately, leaving the user with no way to provide answers and the command hung on an empty answer map. The non-TTY exit-75 escape hatch is lost.
- **Suggested fix:** Tighten the guard to require both streams to be TTYs before going inline. Concrete change at run.ts:353:
  ```ts
  if (process.stdout.isTTY && process.stdin.isTTY) {
    process.stdout.write(`  ${SYMBOLS.dot} paused for input — answering inline\n`);
    const { default: answerCommand } = await import('./answer.js');
    await answerCommand([result.runId], {});
    return;
  }
  ```
  And the matching change at resume.ts:441. Add a third test case to each file asserting the exit-75 path fires when `stdin.isTTY === false` even if `stdout.isTTY === true`.
- **Decision:**

---

## Section D — Defect 4: `--verbose` flag forwarding in `relay resume`

### D.1 — `verbose?: boolean` field added to `ResumeCommandOptions` — **PASS**

- `packages/cli/src/commands/resume.ts:222-232` adds `verbose?: boolean` to the public interface with a JSDoc comment matching the equivalent field on `RunCommandOptions` (`run.ts:56-57`). Field name, type, and doc-comment are byte-identical between the two interfaces.
- **Decision:**

### D.2 — Verbose forwarding block lands after the worktree block — **PASS**

- `packages/cli/src/commands/resume.ts:396-401`:
  ```ts
  if (options.worktree === false) {
    resumeOpts.worktree = false;
  }
  if (options.verbose === true) {
    resumeOpts.verbose = true;
  }
  ```
  Mirrors the run.ts conditional-forwarding pattern (run.ts:258-263) exactly. Only sets the field when explicitly `=== true`, matching the orchestrator's expectation of an unset-or-true tri-state.
- The global `--verbose` flag is registered on the program at `dispatcher.ts:112` and propagated into command options via the spread `{ ...program.opts(), ...cmdOpts }` at `dispatcher.ts:202`. So `relay resume <id> --verbose` correctly populates `options.verbose === true` on the resume command.
- Test `[D1]` (`resume.test.ts:463-479`) asserts the forwarded option. Test `[D2]` (`resume.test.ts:481-498`) asserts the absence path — `resumeOpts['verbose']` is not set when the flag is absent.
- **Decision:**

### D.3 — Verbose is not declared on the resume sub-command in dispatcher — **FLAG-3**

- **File:** `packages/cli/src/dispatcher.ts:194-203`
- **Spec / decision:** Brand-grammar / CLI affordance. Commander prints `--help` per-subcommand; users running `relay resume --help` should see every flag the subcommand reacts to.
- **Finding:** The resume sub-command registration at `dispatcher.ts:194-203` adds `--provider` and `--no-worktree` but not `--verbose`. The flag works at runtime because `--verbose` is a program-level option that flows through `program.opts()`, but `relay resume --help` will not list it. Users who do not know to look at `relay --help` for the global flag will assume verbose is unavailable on resume. This is the inverse symmetry problem to run.ts, which also does not declare `--verbose` locally; for run the omission is the same. The verbose fix delivered the wiring without surfacing the affordance.
- **Suggested fix:** Add `--verbose` as a local option on both the run and resume sub-commands so commander lists it in subcommand help, and so the user can discover it via `relay resume --help`. Concrete change at dispatcher.ts:194-203:
  ```ts
  program
    .command('resume <runId>')
    .description('continue a failed or stopped run')
    .option('--provider <name>', 'provider to use (overrides settings)')
    .option('--no-worktree', 'disable per-run git worktree isolation')
    .option('--verbose', 'render the per-step event sub-stream')
    .action(
      async (
        runId: string,
        cmdOpts: { provider?: string; worktree?: boolean; verbose?: boolean },
      ) => {
        const handler = await loadCommand('resume');
        await handler([runId], { ...program.opts(), ...cmdOpts });
      },
    );
  ```
  Make the same change to the run sub-command at dispatcher.ts:175-192. The flag still works without this change — it is purely a discoverability fix.
- **Decision:**

---

## Section E — Tests: regression coverage of the four defect paths

### E.1 — `answer.test.ts` covers Defect 1 (auth/provider) and Defect 2 (banner) — **PASS**

- Three new tests under `describe('answer command — provider registration and auth')` (lines 489-527):
  - `[A1]` registerDefaultProviders called before resume.
  - `[A2]` preAuthedState is a Map of size 1.
  - `[A3]` auth failure exits with code 3, orchestrator never invoked.
- One new test under `describe('answer command — re-pause banner')` (lines 533-566):
  - `[B1]` renderPausedBanner called once with `{ stepId: 'step2' }`, exit 75, old plain-text lines absent.
- Pre-existing mocks for `loadState`, `atomicWriteJson`, `StateMachine`, `Orchestrator`, `loadFlow`, `paused-banner`, and `load-flow-and-auth` cover all dependencies.
- No live subprocess calls; `vi.spyOn(process, 'exit')` throws to capture exit code; `vi.restoreAllMocks()` in `afterEach`.
- **Decision:**

### E.2 — `run.test.ts` covers Defect 3 (inline answer on pause) — **PASS**

- New `describe('relay run — inline answer on pause')` block (lines 275-327) with two tests:
  - `[C1]` TTY → answerCommand called, exit 75 NOT called.
  - `[C2]` non-TTY → exit 75 called, answerCommand NOT called.
- Pre-existing mocks already cover the run pipeline (`Orchestrator`, `loadFlow`, `parseInputFromArgv`, `renderPausedBanner`).
- New mock for `../../src/commands/answer.js` (line 72-74) intercepts the dynamic import.
- TTY restoration in `afterEach` via `Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true, writable: true })` (lines 284-291) — correct shape for restoring a non-data property.
- **Decision:**

### E.3 — `resume.test.ts` covers Defect 3 (inline answer) and Defect 4 (verbose) — **PASS**

- `describe('relay resume — inline answer on pause')` (lines 387-460) with two tests: `[C3]` TTY and `[C4]` non-TTY. Test `[C4]` is particularly careful — it stubs `process.exit` to a no-op specifically so the in-try-block `exit(75)` is not caught and re-mapped to `exit(1)` by the outer catch handler. This locks in the contract that pause is not an error.
- `describe('relay resume — verbose flag forwarding')` (lines 462-498) with two tests: `[D1]` forwarded when `--verbose`, `[D2]` not set when absent.
- Shared helper `setupSuccessfulResumePipeline(resumeResult)` (lines 366-385) drives the test through to the post-resume branch with a configurable result — pattern eliminates copy-paste across the four new tests.
- **Decision:**

### E.4 — Test coverage of corner cases per the corner-coverage rule — **FLAG-4**

- **File:** `packages/cli/tests/commands/answer.test.ts`, `packages/cli/tests/commands/resume.test.ts`, `packages/cli/tests/commands/run.test.ts`
- **Spec / decision:** Memory rule `feedback_corner_coverage.md`: "Cover every corner, not just the success path — feature delivery is incomplete unless every reachable status/retry/error variant is exercised."
- **Finding:** The new tests cover the happy paths and the primary error branches, but several reachable corners are still untested:
  1. **No test for `flow-ref.json` corruption in `relay answer`.** The block at `answer.ts:244-271` is untested. The resume tests cover the structurally identical block in resume.ts (`[RES-015]`, `[RES-016]`), but the answer-side branch should have its own coverage since the failure message text differs ("could not load flow-ref.json for run …" vs the resume version).
  2. **No test for `mockLoadFlow` failure in the re-pause path.** Line 453 of answer.ts: `const flowLoadResult = await loadFlow(flowRef.flowPath, process.cwd());`. The branch `flowLoadResult.isOk()` is exercised; the `false` branch (which falls back to `topoOrder = []`) is not. A future change to renderPausedBanner that requires a non-empty topoOrder would silently regress this fallback.
  3. **No test for `mockOrchestratorResume` returning `failed` or `aborted` in answer.ts.** Lines 459-466 handle the failure exit; there is no `[ANS-failed]` or `[ANS-aborted]` case in the new tests. The branch is technically exercised by `[ANS-005]`-style malformed-JSON tests indirectly, but not through the orchestrator-returns-failure path.
  4. **No test asserting `state.flowName` (not `flowRef.flowName`) is the value passed to `renderPausedBanner`.** Test `[B1]` only checks the 5th argument (`awaitingInput`); the 1st argument (`flowName`) is not asserted, so a future swap of the two sources would not be caught.
- **Suggested fix:** Add four targeted tests:
  - `[ANS-flowref-malformed]` — `mockReadFile.mockResolvedValue('{ not json')` → exit 1 with `could not load flow-ref.json` in stderr.
  - `[B2]` — `mockLoadFlow.mockResolvedValue(err(...))` while resume returns paused → assert `renderPausedBanner` is called with `topoOrder = []` (4th argument).
  - `[ANS-resume-failed]` — `mockOrchestratorResume.mockResolvedValue(makeRunResult('failed'))` → exit 1, stderr contains `failed after resume`.
  - Extend `[B1]` to assert `mockRenderPausedBanner.mock.calls[0][0] === 'test-flow'` (flowName arg).
- **Decision:**

---

## Project constraint verifications

### No emojis in any source or test file — **PASS**

- `grep -nE '👀|✨|🚀|🎉|❌|✅'` across the six touched files returns zero hits. Symbol vocabulary is sourced from `SYMBOLS.fail`, `SYMBOLS.warn`, `SYMBOLS.dot`, `SYMBOLS.ok` (brand.js), no inline glyphs.
- **Decision:**

### No `simply` in any user-visible string — **PASS**

- `grep -nE '\bsimply\b'` across the six touched files returns zero hits.
- **Decision:**

### No trailing exclamation marks in user-visible copy — **PASS**

- New stdout/stderr writes scanned: `paused for input — answering inline`, `run ${runId} completed`, `run ${runId} ${result.status} after resume`, the error lines under `formatError`. Zero trailing exclamations.
- **Decision:**

### Atomic writes for any file other processes might read — **PASS**

- The answer handoff write at `answer.ts:403` uses `atomicWriteJson(handoffPath, answers)` (unchanged from prior sprints).
- The state.json write at `answer.ts:427` uses `machine.save()` which routes through `atomicWriteJson` under the hood.
- No new direct write sites added in sprint 51.
- **Decision:**

### Conventional Commits — **PASS**

- All four sprint-51 commits follow `<type>(<scope>): <subject>`: `fix(cli)`, `fix(cli)`, `fix(cli)`, `test(cli)`. No `task_N`/`FLAG-N`/`BLOCK-N` identifiers in subjects. The fix-commit bodies mention `task_152`-`task_157` for traceability, which the recent docs commit `1c566eb` permits.
- **Decision:**

### ESM-only Node ≥20.10 — **PASS**

- All new imports use `.js` extensions. The dynamic `await import('./answer.js')` is also `.js`-suffixed. No CJS shims added.
- **Decision:**

### CLI source file 400-line cap — see Other follow-ups

- All three command files exceed the 400-line cap. Pre-existing systemic issue; not a blocker. Detail in the carry-over section.

---

## Other follow-ups (out of sprint-51 scope)

- **CLI 400-line file-size cap.** `pnpm -F @ganderbite/relay lint:filesize` reports nine files over the cap: `lint.ts` (570), `logs.ts` (531), `resume.ts` (484, +1 in sprint 51), `answer.ts` (478, +101 in sprint 51), `install.ts` (458), `run.ts` (447, +9 in sprint 51), `dispatcher.ts` (418), `registry.ts` (410), `input-parser.ts` (404). The sprint-51 defect fixes pushed all three command files further past the cap. Per the orchestrator brief this is a pre-existing systemic concern, not a blocker for sprint 51. A dedicated future sprint should extract per-command helpers — for answer.ts in particular, the flow-ref-loading block (lines 244-271) and the auth block (lines 279-295) are obvious extraction targets that would shave ~50 lines without changing behaviour.
- **Legacy `race` / `runner` nouns in code comments.** `run.ts:2-10` and a handful of inline comments still use the old vocabulary (`relay run — executes a race`, `runners`, `race metadata`). Not user-visible, not touched by sprint 51, but worth a sweep when the file-size refactor lands.
- **`new URL('./resume.js', import.meta.url).pathname` pattern at run.ts:75.** The sprint-51 inline-answer change adopted the bare `import('./answer.js')` pattern, which is cleaner and Windows-safe. Migrating the older site to the same shape would be a one-line cleanup, but it carries the `--resume` delegate path so a small regression test should accompany the change.
- **Pre-existing Biome infos.** Template-literal and computed-key-access infos on the touched files predate sprint 51 and were not flagged here per the orchestrator brief.
- **No public-API drift in `@ganderbite/relay-core`.** Sprint 51 was CLI-only — no new core exports, no new error classes, no changes to `RunResult` or `RunState` shape. The new `registerDefaultProviders` import in answer.ts is a pre-existing export.
