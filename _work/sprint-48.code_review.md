# Sprint 48 · P0 structural splits, flaky test fix, CLI deduplication, and coverage gate — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits

- `deb496c` (refactor: split orchestrator and progress, extract loadFlowAndAuth helper, stabilize ABORT-001)
- `8a28c37` (test(cli): add coverage for paused-banner, telemetry, nine zero-coverage commands, and error-formatting regression guard)
- `31efe77` (test: cover progress submodules, add CLI end-to-end harness, gate coverage at honest thresholds)

**Summary:** 0 BLOCK, 9 FLAG, 18 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## Section A — Orchestrator split (task_117 ABORT-001 fix, task_118 module extraction)

### A.1 — ABORT-001 / ABORT-002 stabilised via in-flight gate plus 30 s timeout — **PASS**

- `packages/core/tests/orchestrator/orchestrator.test.ts:354-403` (ABORT-001) and `406-442` (ABORT-002) replace the prior fixed-delay `setTimeout`-based SIGINT with a promise-gated trigger. The mock response factory resolves `signalInflight` only after the step is confirmed in flight (`responses.slow` line 369 / `responses.slow` line 416), and `void inFlight.then(() => process.emit('SIGINT'))` (line 396 / line 438) fires the signal exactly once the orchestrator's handler is registered.
- The `it(..., { timeout: 30_000 }, async () => {...})` form at line 354-356 raises the per-test deadline to 30 s with the required sentinel comment ("Timeout raised to 30s — SIGINT abort takes longer under coverage instrumentation overhead.") on the same line.
- SIGINT registration ordering: `executeRun` (`packages/core/src/orchestrator/execute-run.ts:68-69`) installs `process.on('SIGINT', onSigint)` synchronously before any `await`; the test's gate fires SIGINT only after the step's executor runs, which is necessarily after the handler is registered. The fix is correctly synchronised.
- ABORT-002 carries the same pattern with SIGTERM (`tests/orchestrator/orchestrator.test.ts:406-442`). Both assertions on `state.status === 'aborted'` and `state.steps.slow.status === 'failed'` are preserved.
- No source files in `packages/core/src/` were modified to land the fix.
- **Decision:**

### A.2 — Module split produces `dag-walk.ts` + `auth.ts` + `execute-run.ts` and a 328-line `orchestrator.ts` — **PASS**

- `packages/core/src/orchestrator/orchestrator.ts` is 328 lines (target ≤ 400). The class delegates to `executeRun` (which wraps `walkDag` and `resolveAndAuthenticate`) and exposes the same `run` / `resume` / constructor signatures the prior monolith carried.
- `packages/core/src/orchestrator/dag-walk.ts` is 346 lines (target ≤ 400). Exports `walkDag(ctx: DagWalkContext): Promise<WalkResult>` with a discriminated `WalkResult = { status: 'succeeded' | 'failed' | 'aborted' | 'paused'; firstError; pausedStepId? }`. The walker installs and removes its own AbortController listener inside a try/finally (lines 158-345), and propagates `StateWriteError` verbatim instead of swallowing it as a step failure.
- `packages/core/src/orchestrator/auth.ts` is 148 lines (target ≤ 150). Exports `resolveAndAuthenticate`, `resolveRunProvider`, `authenticateProvider`, `authenticateProviders` with typed `AuthTimeoutError`/`RunAbortedError` propagation. `authenticateProvider` clears its timer and removes its abort listener in `finally` so the event loop is not held open.
- The public Orchestrator class shape (`OrchestratorOptions`, `RunOptions`, `RunResult`) is preserved by re-exporting from `./run-options.js` at `orchestrator.ts:22-27`. `Orchestrator.resume()` still wires `seedReadyQueueForResume` from `resume.ts:154-187` and hands the resulting queue to `executeRun({ initialQueue })` — the resume path is wired through the same execution boundary as `run()` and does not modify `resume.ts` beyond preserving its existing exports.
- `packages/core/src/orchestrator/index.ts:1-32` re-exports `walkDag`, `resolveAndAuthenticate`, and the new context/result types so integration tests can address them directly.
- **Decision:**

### A.3 — Scope expanded beyond declared targets: `step-dispatch.ts`, `execute-run.ts`, `run-bootstrap.ts`, `run-options.ts`, `run-internal.ts`, `worktree-setup.ts` extracted alongside the declared two — **FLAG-1**

- **File:** `packages/core/src/orchestrator/step-dispatch.ts` (624 lines), `execute-run.ts` (202), `run-bootstrap.ts` (98), `run-options.ts` (172), `run-internal.ts` (34), `worktree-setup.ts` (134).
- **Spec / decision:** Task brief `task_118` listed only `dag-walk.ts` and `auth.ts` as new files; the line-budget rule says "Each new file must stay ≤ 400 lines."
- **Finding:** The systems-engineer split the monolith into six new files in addition to the declared two. The decomposition is well-shaped — `step-dispatch.ts` owns per-step state transitions, retry, and the dispatch-step closure; `execute-run.ts` is the single boundary that wires auth + worktree + walker for both `run()` and `resume()`; `run-bootstrap.ts` carries `writeFlowRef`/`writeHandoffHelper`/`closeProviders`; `worktree-setup.ts` carries the worktree probe/teardown. Each is focused and well-documented. The public Orchestrator class API is unchanged. **However**, `step-dispatch.ts` lands at 624 lines — over the task's ≤ 400 budget. The file mostly holds the `createStepDispatcher` factory closure (`step-dispatch.ts:72-564`) plus three helpers. The single-closure shape makes it hard to split further without leaking shared mutable state through parameter lists, so the over-budget figure is defensible but not free. The other five extracted files are well under their natural budget.
- **Suggested fix:** Either (a) accept the over-budget `step-dispatch.ts` as a deliberate trade-off and update the line-budget rule to exempt single-closure dispatch factories, or (b) extract `runBodyStep` (`step-dispatch.ts:253-346`) and `handlePause` (`step-dispatch.ts:456-558`) into their own files with the dispatcher passed as an argument — this would land `step-dispatch.ts` near 400 lines at the cost of two more module boundaries. Either way, the scope expansion deserves a follow-up commit message note so the next reviewer sees the deviation as intentional.
- **Decision:** Option (a)

### A.4 — `executeRun` re-applies the SIGINT/SIGTERM handler on every run() and resume() call — **FLAG-2**

- **File:** `packages/core/src/orchestrator/execute-run.ts:60-69, 158-159`
- **Spec / decision:** Process-handler hygiene. The pre-split orchestrator installed handlers the same way; the split preserved the behaviour verbatim. Concern is that resume-on-pause cycles now route through `executeRun` twice (run → pause → resume), and each invocation installs/removes its own handler pair.
- **Finding:** `executeRun` does `process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);` on entry (lines 68-69) and `process.removeListener(...)` in the finally (lines 158-159). A single Orchestrator instance reused across multiple `run()`/`resume()` calls — say, an embedded host — would install and tear down handlers per call. There is no listener leak (the finally is unconditional), but if a caller invokes `executeRun` while a previous invocation is still in flight, both invocations will receive SIGINT and abort their respective controllers. Not a correctness issue today since the Orchestrator does not support concurrent runs (`orchestrator.ts:48-49` documents this), but it is worth a note for future embedding.
- **Suggested fix:** Add a JSDoc line on `executeRun` documenting the handler-installation policy ("Installs process-level SIGINT/SIGTERM listeners for the duration of one run. Concurrent calls are not supported — both invocations would share the same signal."). No code change required.
- **Decision:** fix now.

### A.5 — `loadFlowAndAuth` reproduces auth-bootstrap logic that already lives in `core/orchestrator/auth.ts` — **FLAG-3**

- **File:** `packages/cli/src/load-flow-and-auth.ts:42-75` and `packages/core/src/orchestrator/auth.ts:30-122`.
- **Spec / decision:** DRY. Memory rule "keep it simple, don't reinvent the wheel" — the CLI's `authenticateProvider` is a thinner version of the core's `resolveAndAuthenticate`, but lacks the timeout/signal handling.
- **Finding:** The CLI now exports `authenticateProvider({provider?, cwd, flowDir})` which calls `loadGlobalSettings + loadFlowSettings + resolveProvider + provider.authenticate()`. The core exports `resolveAndAuthenticate({flagProvider, flowDir, registry, authTimeoutMs?, signal, preAuthedState?})` which does the same plus a wall-clock timeout and abort-signal wiring. The CLI version has no timeout — a hung `authenticate()` call would block the CLI banner indefinitely, where the core path would surface `AuthTimeoutError` after 30 s. The CLI does not pass an AbortSignal either, so SIGINT during the banner-auth probe is not cancellable mid-flight. Naming overlap is also confusing: `authenticateProvider` exists in both packages with different signatures (core: single-provider auth with timeout; CLI: full settings + resolve + auth).
- **Suggested fix:** Either (a) have the CLI helper delegate to `resolveAndAuthenticate` from `@ganderbite/relay-core` with `authTimeoutMs: 30_000` and a fresh AbortController so behaviour matches the orchestrator's auth bootstrap, or (b) rename the CLI helper to `resolveAndAuthenticateCli` to avoid shadowing. Concrete sketch for (a):
  ```ts
  export async function authenticateProvider(opts: {
    provider?: string;
    cwd: string;
    flowDir: string;
  }): Promise<
    Result<{ resolvedProvider: Provider; authState: AuthState }, PipelineError>
  > {
    registerDefaultProviders();
    const controller = new AbortController();
    try {
      const result = await resolveAndAuthenticate({
        ...(opts.provider !== undefined ? { flagProvider: opts.provider } : {}),
        flowDir: opts.flowDir,
        registry: defaultRegistry,
        signal: controller.signal,
      });
      return ok({
        resolvedProvider: result.provider,
        authState: result.authState ?? throwAssertHasAuth(),
      });
    } catch (caught) {
      if (caught instanceof PipelineError) return err(caught);
      throw caught;
    }
  }
  ```
- **Decision:** fix now. Option (a)

### A.6 — Settings IO failures are silently swallowed by the CLI helper but throw in the core helper — **FLAG-4**

- **File:** `packages/cli/src/load-flow-and-auth.ts:53-60` and `packages/core/src/orchestrator/auth.ts:57-60`.
- **Spec / decision:** Behavioural consistency between the CLI pre-auth banner and the orchestrator's auth bootstrap.
- **Finding:** The CLI's `authenticateProvider` calls `Promise.all([loadGlobalSettings(), loadFlowSettings(flowDir)])` and then `globalSettings = globalResult.isOk() ? globalResult.value : null` — any settings IO error (corrupt JSON, EACCES on ~/.relay/settings.json) is silently dropped and resolution proceeds with `null`. The core helper at `auth.ts:57-60` throws on the same errors. The CLI's silent swallow means an operator whose global settings.json is corrupted will get a `NoProviderConfiguredError` from `resolveProvider` instead of the actionable "settings.json is malformed: ..." error. The two paths should surface the same diagnostic.
- **Suggested fix:** Propagate settings errors from the CLI helper too. Either (a) return `err(globalResult.error)` / `err(flowResult.error)` from `authenticateProvider` so the operator sees the corruption directly, or (b) preserve the silent-fallback semantics but log a warn-level breadcrumb so the CI artifact carries the cause. Option (a) is more honest; the CLI's exit-code map already handles settings errors via `PipelineError`.
- **Decision:** fix now. Option (a)

---

## Section B — Progress split (task_119)

### B.1 — `progress.ts` reduced to a 2-line shim; new `progress/index.ts` composes `watch.ts` + `render.ts` — **PASS**

- `packages/cli/src/progress.ts:1-2` is `export type { AuthInfo } from './progress/index.js'; export { ProgressDisplay } from './progress/index.js';` — exactly the brief's "thin re-export shim" shape. All existing import sites (`run.ts:34`, `resume.ts:33`) compile without changes.
- `packages/cli/src/progress/watch.ts` is 279 lines (target ≤ 300). Exports `startWatcher`, `WatcherHandle`, and the discriminated `WatchEvent` union (`LiveStateEvent | EventsRecordEvent`). Encapsulates the chokidar watcher, byte-offset events tailer, and step-id filter.
- `packages/cli/src/progress/render.ts` is 384 lines — target was ≤ 350 (over by 34). Exports `ProgressRenderer<TInput>` with `start`, `stop`, `onEvent`, `updateRunnerMetrics`. The over-budget reflects the rendering surface (auth-info row, spinner ticks, verbose-mode accumulator, three-zone layout) honestly; further extraction would split a single cohesive UI module.
- `packages/cli/src/progress/index.ts:42-127` wires `startWatcher` to `ProgressRenderer.onEvent` and preserves the prior `ProgressDisplay` constructor signature (`runDir, flow, auth, verbose?`).
- **Decision:**

### B.2 — `progress/render.ts` overshoots the 350-line target — **FLAG-5**

- **File:** `packages/cli/src/progress/render.ts` (384 lines).
- **Spec / decision:** Task brief `task_119`: "render.ts: ≤ 350 lines."
- **Finding:** The renderer is 34 lines over budget. The bulk lives in `#stepRow` (lines 300-377) and `#onLiveState`/`#onEventsRecords` (lines 189-275) — both are reasonably tight given they own the symbol → status mapping, the spinner advance, the verbose accumulator, and the final-row format. The over-budget figure is small and the structure is clean; splitting would require either (a) extracting the verbose accumulator into its own file or (b) extracting the row-renderer pure function into a separate module.
- **Suggested fix:** Either (a) extract `VerboseAccumulator` plus `makeAccumulator` / `#applyEventToAccumulator` / `#buildAccumulatorLines` into `progress/verbose-accumulator.ts` (~80 lines), landing render.ts at ~300 lines, or (b) accept the modest over-budget as a single-renderer trade-off and revise the task budget for future split work.
- **Decision:** option (b)

### B.3 — Progress test file mocks the renderer through the real chokidar watcher — **PASS**

- `packages/cli/tests/progress.test.ts` is restructured into `describe('watch.ts')` (7 tests, lines 102-335) and `describe('render.ts')` (10 tests, lines 339-528) plus the original `ProgressDisplay cumulative token accumulation` block (lines 580-680). The watch.ts tests write real files to a tmp dir and await events through `waitForEvents` with a 5 s timeout backstop. The render.ts tests exercise the non-TTY path via stderr spies — log-update is never invoked because `process.stdout.isTTY === false` in vitest.
- The byte-offset incremental tail test at line 292-335 covers the partial-line buffer behaviour that distinguishes this implementation from a naive whole-file re-read.
- **Decision:**

---

## Section C — `loadFlowAndAuth` deduplication (task_120)

### C.1 — `loadFlowOnly` replaces inline `red(SYMBOLS.fail)` in `dry-run.ts` and `validate.ts` — **PASS**

- `packages/cli/src/commands/dry-run.ts:252-263` and `packages/cli/src/commands/validate.ts:32-41` both call `loadFlowOnly({ cwd: process.cwd(), nameOrPath })`. On error they branch on `instanceof FlowDefinitionError` to pick `EXIT_CODES.definition_error` vs `EXIT_CODES.runner_failure`, then write `formatError(loadErr) + '\n'` to stderr. No inline `red(SYMBOLS.fail + ...)` error rendering remains for load-error paths.
- The remaining `red()` calls in those files (`dry-run.ts:247` — "usage: relay dry-run", `dry-run.ts:271` — input parse error; `validate.ts:28` — "usage: relay validate") are usage errors that are not `PipelineError` shapes, and each carries the required `// usage-error: formatError does not apply` sentinel comment within the preceding 5-line window so the regression test passes.
- **Decision:**

### C.2 — `loadFlowAndAuth` in `run.ts`; `authenticateProvider` in `resume.ts`; `answer.ts` untouched — **PASS**

- `packages/cli/src/commands/run.ts:102-112` calls `loadFlowAndAuth({ provider?, cwd, nameOrPath })` and destructures `{ flow, flowDir, resolvedProvider, authState }`. The prior inline load+auth block (lines 108-167 in the pre-refactor file) is gone.
- `packages/cli/src/commands/resume.ts:344-354` calls `authenticateProvider({ provider?, cwd, flowDir })` for the auth-only path (the flow itself is loaded via `loadFlow` against `flowRef.flowPath`, which is correct — resume must not re-resolve the flow name).
- `packages/cli/src/commands/answer.ts` was not modified for auth wiring. The agent's report ("no auth-only block") is correct — answer.ts has zero `authenticate()` / `loadGlobalSettings()` / `resolveProvider()` references. It dispatches to `Orchestrator.resume()` at line 360 which performs its own auth bootstrap via `resolveAndAuthenticate`. The lack of a `--provider` flag on `answer` (`AnswerCommandOptions` carries only `json?`) is consistent with the pre-sprint design.
- **Decision:**

### C.3 — `flagProvider` is forwarded twice in `run.ts` — once into `loadFlowAndAuth` and again into `orchestrator.run()` — **FLAG-6**

- **File:** `packages/cli/src/commands/run.ts:102-110, 246-248, 261-263`.
- **Spec / decision:** `task_120`-introduced redundancy. The first `loadFlowAndAuth` call resolves the provider AND authenticates; `preAuthedState` then forwards the AuthState into `orchestrator.run()` to skip the second probe.
- **Finding:** `runCommand` calls `loadFlowAndAuth({ provider: options.provider, ... })` at line 102-106 — this resolves the provider via the three-tier chain. Then at line 246-248 it sets `runOpts.flagProvider = options.provider` so the orchestrator re-runs the same resolution. The `preAuthedState` map (line 261-263) suppresses the actual `authenticate()` probe on the orchestrator side, but the resolution work (loadGlobalSettings + loadFlowSettings + resolveProvider) still runs twice. The redundancy is invisible to the user but it doubles the settings-read I/O on every `relay run` invocation and risks the two resolutions diverging if (somehow) the on-disk settings file changes between the banner and the orchestrator's auth call.
- **Suggested fix:** Either (a) thread the resolved provider name into a new `RunOptions.resolvedProviderName?: string` (or a richer `preResolved` map) so the orchestrator skips re-resolution entirely when the CLI has already locked it in, or (b) accept the double-read as a deliberate consistency choice and document the rationale in `run.ts:246-248`. Option (b) is the cheaper fix.
- **Decision:** fix now. option (a)

### C.4 — `firstPendingStepId`, `UpgradeOutcome`, and `renderOutcome` newly exported for testing — **PASS**

- `packages/cli/src/commands/resume.ts:75-86` adds `export function firstPendingStepId(topoOrder, steps): string` with the JSDoc tag `Exported for testing.` This is a pure helper that does not pull any test-only types into the production runtime — the function is a topological-order scan over the existing `RunState.steps` shape.
- `packages/cli/src/commands/upgrade.ts:78-85` adds `export interface UpgradeOutcome` and `132-158` adds `export function renderOutcome(outcome)`. Both carry `Exported for testing.` JSDoc. `UpgradeOutcome` is a plain data shape consumed only by `renderOutcome`; `renderOutcome` is a pure string-builder. Neither leaks test-only types or stubs into the public surface.
- Per the dispatcher pattern, command modules are loaded via dynamic `default` import — the extra named exports are runtime-harmless and do not enlarge the published package surface.
- **Decision:**

---

## Section D — Error-formatting audit (task_121)

### D.1 — Regression grep test enforces the `usage-error` sentinel on every `red(SYMBOLS.fail)` call — **PASS**

- `packages/cli/tests/error-format-regression.test.ts:25-44` walks every `.ts` under `packages/cli/src/commands/` and flags any line that matches `red(.*SYMBOLS\.fail` whose preceding 5-line window lacks the sentinel `// usage-error: formatError does not apply`. The 5-line window is documented inline (line 22-23).
- The test fails fast with a violations-as-list assertion (`expect(violations, ...).toHaveLength(0)`) so a new offender is clear from the failure message.
- All `red(SYMBOLS.fail)` call sites in `answer.ts` (12 sites), `dry-run.ts` (1), `validate.ts` (1), `resume.ts` (5), `upgrade.ts` (1), and the helper line in `progress/render.ts` carry the sentinel where applicable.
- **Decision:**

### D.2 — `upgrade.ts:184` writes `${SYMBOLS.fail}` to stdout without `red()`, bypassing the regression test — **FLAG-7**

- **File:** `packages/cli/src/commands/upgrade.ts:182-186`.
- **Spec / decision:** Brand consistency. The product spec is canonical: failure messages render `red(SYMBOLS.fail)` so the symbol vocabulary carries colour discipline.
- **Finding:** When `relay upgrade <flow>` cannot find the named flow, line 184 emits `  ${SYMBOLS.fail} ${targetFlow} is not installed. run: relay install ${targetFlow}\n` to stdout. The grep regression test only catches `red(.*SYMBOLS.fail` patterns, so this bare `${SYMBOLS.fail}` slips past — but the user sees a fail symbol with no red colour. Other usage errors in the same package go through `red(SYMBOLS.fail + ...)` with the sentinel; the asymmetry will eventually catch someone's eye.
- **Suggested fix:** Wrap the symbol in `red()` and add the sentinel:
  ```ts
  // usage-error: formatError does not apply — missing target flow is not a PipelineError type
  process.stdout.write(
    red(`  ${SYMBOLS.fail} ${targetFlow} is not installed`) +
      gray(`. run: relay install ${targetFlow}`) +
      "\n",
  );
  ```
  Optionally update the regression test to also flag bare `${SYMBOLS.fail}` patterns inside a `process.stdout.write` call so future drifts are caught.
- **Decision:** fix now.

### D.3 — Pre-existing spec refs (`§6.7`, `§6.8`, `§11.5`) in `resume.ts`, `upgrade.ts`, `run.ts` were not removed during the sprint-48 audit — **FLAG-8**

- **File:** `packages/cli/src/commands/resume.ts:5, 91, 368`; `packages/cli/src/commands/upgrade.ts:15, 199`; `packages/cli/src/commands/run.ts:180`.
- **Spec / decision:** Memory rule "Code comments must be self-contained — no spec refs (§4.2, etc.)". The pre-existing comments were carried over from earlier sprints; sprint 48 modified these files (load-flow-and-auth wiring, helper exports) but did not strip the §-references.
- **Finding:** Six §-references remain across three files. These pre-date sprint 48 — the sprint-47 review (`Other follow-ups`) already noted the pre-existing refs in `resume.ts` and `paused-banner.ts` carrying over. Sprint 48 touched these files for unrelated reasons and left the refs intact. The rule is unambiguous: code comments do not carry spec citations. The sprint-48 scope is the right time to clear them since the files are already in the diff.
- **Suggested fix:** Strip the §-citations from the affected comments; rewrite them as self-contained prose. For example, `resume.ts:5` ("Pre-resume banner verbatim per product spec §6.7") becomes "Pre-resume banner — verbatim string contract; the file is the canonical reference." Same treatment for the other five sites.
- **Decision:** fix now.

---

## Section E — Coverage additions (tasks 122-126)

### E.1 — `paused-banner.ts` snapshot coverage across four pause branches — **PASS**

- `packages/cli/tests/paused-banner.test.ts` covers four distinct rendering branches: top-level Ctrl-C pause (lines 58-138, 4 tests), top-level ask pause with `awaitingInput.stepId` (lines 142-194, 2 tests), loop-body ask pause with `loopStepId + loopIter` (lines 198-232, 1 test), and a minimal-fallback case when state.json is missing.
- All assertions go against captured stdout via `vi.spyOn(process.stdout, 'write')`. A real tmp dir holds `state.json` and `metrics.json` so the file-read path is exercised end-to-end.
- The snapshot at `paused-banner.test.ts.snap` locks in the exact byte sequence so any future drift in the banner contract surfaces as a snapshot diff.
- **Decision:**

### E.2 — `telemetry.ts` opt-in/opt-out/network-failure coverage — **PASS**

- `packages/cli/tests/telemetry.test.ts:114-194` tests opt-out (telemetry disabled, lines 114-132), opt-in network success (lines 136-158), and three failure modes — `fetch` rejection (lines 159-163), non-OK HTTP response (lines 165-171), and HTTP timeout via fake timers (lines 173-184). The "must not throw" invariant is asserted via `await expect(...).resolves.toBeUndefined()` at lines 161, 170, 194.
- `loadGlobalSettings` is mocked at the `@ganderbite/relay-core` boundary; `globalThis.fetch` is stubbed via `vi.stubGlobal`. No live network calls or filesystem I/O outside the mock.
- **Decision:**

### E.3 — Five zero-coverage commands gain unit tests (resume, new, upgrade, publish, test) — **PASS**

- `packages/cli/tests/commands/resume.test.ts` — 13 tests covering `firstPendingStepId` (3 cases), missing-runId guard, paused-run rejection, StateNotFoundError, generic state load error, null flowPath guard, flow-load failure, and CostTracker integration. Mocks `loadState`, `loadFlow`, `authenticateProvider`, `Orchestrator.resume`, `CostTracker`.
- `packages/cli/tests/commands/new.test.ts` — 9 tests for template resolution, directory creation, and scaffold integration with `relay-generator`.
- `packages/cli/tests/commands/upgrade.test.ts` — 12 tests for `renderOutcome` (updated, current, downgrade, failed) and the end-to-end command flow with mocked install.
- `packages/cli/tests/commands/publish.test.ts` — 6 smoke tests covering flow-package validation, registry client invocation, and error surface.
- `packages/cli/tests/commands/test.test.ts` — 4 smoke tests covering test-runner invocation.
- All five files use `vi.hoisted` + `vi.mock` to isolate the command from real dependencies. No live network or live Orchestrator calls.
- **Decision:**

### E.4 — Four lower-density commands gain coverage (list, runs, search, glossary) — **PASS**

- `packages/cli/tests/commands/list.test.ts` — 10 tests covering empty list, populated list, filter logic, missing flows dir.
- `packages/cli/tests/commands/runs.test.ts` — 11 tests covering empty run dir, multiple runs, status filtering, malformed entries.
- `packages/cli/tests/commands/search.test.ts` — 11 tests covering match found / no match / registry fetch errors.
- `packages/cli/tests/commands/glossary.test.ts` — 4 tests with one snapshot covering the canonical glossary entries.
- All four files mock filesystem reads and registry fetches.
- **Decision:**

### E.5 — Progress submodule coverage (`watch.ts`, `render.ts`) — **PASS**

- `packages/cli/tests/progress.test.ts:102-335` — 7 tests for `startWatcher`: live state emit, ignored unknown step IDs, events-record emit (verbose=true), no events emit (verbose=false), `stop()` resolves and prevents further delivery, malformed JSON handling, byte-offset incremental tailing.
- `packages/cli/tests/progress.test.ts:339-528` — 10 tests for `ProgressRenderer`: structured stderr logging in non-TTY, running/succeeded transitions, unknown stepId no-op, cumulative-token accumulation, verbose-events stderr write, debounce-timer cleanup on stop.
- The original `ProgressDisplay cumulative token accumulation` describe block (lines 580-680) is preserved, so the composed-class path stays covered.
- **Decision:**

### E.6 — CLI end-to-end integration tests via `_harness.ts` — **PASS** (with one FLAG below)

- `packages/cli/tests/integration/_harness.ts:57-95` wraps the real `Orchestrator` constructor to inject the test's `ProviderRegistry` and override `runDir`. The real `loadFlow`, `flow-loader.js`, and the dispatch path all run unmocked, which catches CLI/core API drift that the unit-level harnesses mask.
- `packages/cli/tests/integration/run-end-to-end.test.ts` — 2 tests (`E2E-RUN-001` exit 0 on success, `E2E-RUN-002` non-zero on step failure). The fixture flow is generated at test time using a file:// URL import of the committed dist (`packages/cli/node_modules/@ganderbite/relay-core/dist/index.js`).
- `packages/cli/tests/integration/resume-end-to-end.test.ts` — 2 tests (`E2E-RESUME-001` resume to success, `E2E-RESUME-002` already-succeeded steps not re-invoked). Phase 1 uses `createOrchestrator` directly to produce a partially-failed state, phase 2 calls `resumeCommand`.
- The `mini-mock-flow` fixture at `packages/cli/tests/fixtures/mini-mock-flow/` holds the static prompt files and a `package.json` with the `relay` metadata block. Fixture is test-only and lives under `tests/` — it does not leak into the published package surface.
- **Decision:**

### E.7 — Integration harness duplicates a known typo for the telemetry mock — **FLAG-9**

- **File:** `packages/cli/tests/integration/_harness.ts:119-122`.
- **Spec / decision:** Code hygiene. Commit `5e80e5d` (parent of sprint-48) explicitly removed the `maybySendRunEvent` typo from `tests/commands/run.test.ts`. The new harness re-introduces it.
- **Finding:** The mock object at line 120-121 declares both `maybySendRunEvent: vi.fn()` (typo) and `maybeSendRunEvent: vi.fn()` (correct name). The typo is harmless — vi.mock accepts extra properties — but the duplicate exists because the agent copied the mock from a stale file or transcribed it manually. The recent fix-up commit explicitly removed this typo from `run.test.ts`; reintroducing it here is a regression in code hygiene, not behaviour. The fact that both keys are present suggests the agent was uncertain which export name was correct, which is itself a small signal that should be addressed.
- **Suggested fix:** Drop line 120 entirely:
  ```ts
  vi.mock("../../src/telemetry.js", () => ({
    maybeSendRunEvent: vi.fn(),
  }));
  ```
- **Decision:** fix now.

---

## Section F — Coverage gate (task_127)

### F.1 — CLI vitest config lowered to 40/35/30 with explanatory comment; both configs add `json-summary` reporter — **PASS**

- `packages/cli/vitest.config.ts:14-18` lowers `thresholds` to `{ lines: 40, functions: 35, branches: 30 }` and adds `reporter: ['text', 'json-summary']`. The inline comment on line 17 reads "Honest threshold reflecting current coverage — ratchet up as coverage grows" — the sprint-48 sentinel is clearly framed as a temporary baseline, not a permanent ceiling.
- `packages/core/vitest.config.ts:11-18` adds `json-summary` to its reporter array (`['text', 'html', 'json-summary']`) and preserves the existing `{ lines: 80, functions: 80 }` thresholds — the core threshold is not lowered.
- Both configs write `coverage-summary.json` under `<package>/coverage/` so any future CI workflow can archive the artifact and gate on it.
- **Decision:**

---

## Project constraint verifications

### All fallible public functions return `Result<T,E>` via neverthrow — **PASS**

- `walkDag` returns `Promise<WalkResult>` and throws only for `StateWriteError` (a fatal IO path that the caller is required to observe).
- `resolveAndAuthenticate` / `authenticateProvider` / `authenticateProviders` in `core/orchestrator/auth.ts` throw typed errors verbatim — the orchestrator's `executeRun` catch translates them.
- `loadFlowAndAuth` / `loadFlowOnly` / `authenticateProvider` in `cli/load-flow-and-auth.ts` all return `Promise<Result<..., E>>`.
- `firstPendingStepId`, `renderOutcome`, `UpgradeOutcome` are pure synchronous helpers — Result is not required for non-fallible code.
- **Decision:**

### No emojis in any output, code, or template — **PASS**

- Searched `packages/core/src/orchestrator/*.ts`, `packages/cli/src/progress/*.ts`, `packages/cli/src/load-flow-and-auth.ts`, all updated command files, every new test file, and the integration `_harness.ts`. No emoji code points present. Symbol vocabulary continues to flow from `SYMBOLS` and `MARK` in `packages/cli/src/brand.ts`.
- **Decision:**

### `simply` does not appear in user-visible strings — **PASS**

- `grep -nE '\bsimply\b'` across every modified sprint-48 file returns one hit in `packages/core/src/orchestrator/step-dispatch-context.ts:21` ("by simply") — this is a pre-existing internal JSDoc comment on the dispatch context, untouched in sprint 48, and not a user-visible string. Zero hits in CLI output, README, or template content.
- **Decision:**

### No trailing exclamation marks in user-visible copy — **PASS**

- `grep -nE '!'` across the changed CLI output paths and new test fixtures returns zero hits in user-facing strings. (Logical-not `!` operators in code do not count.)
- **Decision:**

### Atomic writes for any file other processes might read — **PASS**

- `writeFlowRef` (`run-bootstrap.ts:62-74`) and `writeHandoffHelper` (lines 24-55) both route through `atomicWriteJson`. The new `loadFlowAndAuth` and `executeRun` paths do not write any cross-process files of their own; state.json and metrics.json continue to land via `StateMachine.save()` and `CostTracker.persist()` respectively.
- **Decision:**

### Self-contained code comments — no spec refs, no sprint/task IDs — **PARTIAL (see FLAG-8)**

- New files (`dag-walk.ts`, `auth.ts`, `execute-run.ts`, `run-bootstrap.ts`, `run-options.ts`, `run-internal.ts`, `worktree-setup.ts`, `step-dispatch.ts`, `progress/watch.ts`, `progress/render.ts`, `progress/index.ts`, `load-flow-and-auth.ts`, all new test files) carry zero `§<digit>` or `task_<digit>` or `FLAG-<digit>` / `BLOCK-<digit>` references.
- The pre-existing `§6.7`, `§6.8`, `§11.5` references in `commands/resume.ts`, `commands/upgrade.ts`, `commands/run.ts` survive untouched. Captured under FLAG-8 above.
- **Decision:**

### Domain-generic error names — **PASS**

- No new error classes added in sprint 48. Existing taxonomy (`StateWriteError`, `AuthTimeoutError`, `RunAbortedError`, `FlowDefinitionError`, etc.) is preserved verbatim.
- **Decision:**

### Native `z.toJSONSchema`, no third-party `zod-to-json-schema` — **PASS**

- No new third-party JSON schema package added. `run-bootstrap.ts:34, 46` continues to call `z.toJSONSchema(...)` for the handoff helper map — the same usage as pre-split.
- **Decision:**

### ESM-only, Node ≥20.10 — **PASS**

- Every new and modified `.ts` file uses `.js` import extensions throughout. No CJS shims, no `require()` calls (the one `createRequire` in `run.ts:214` is package-metadata lookup, not a CJS shim).
- **Decision:**

### Conventional Commits — **PASS**

- `git log --oneline a5ab5a9..HEAD`: three commits with `refactor:`, `test(cli):`, and `test:` prefixes — all valid Conventional Commits. No `task_N`, `FLAG-N`, or `BLOCK-N` identifiers in the commit subjects or bodies.
- **Decision:**

### Zod v4 idioms — **PASS**

- No new schemas authored in sprint 48. The integration harness's flow-module fixture uses `z.object({ target: z.string().optional() })` — same v4-compatible pattern as the existing generator templates.
- **Decision:**

---

## Other follow-ups (out of sprint-48 scope)

- The pre-existing `§` references in `commands/resume.ts`, `commands/upgrade.ts`, and `commands/run.ts` carry over from earlier sprints (FLAG-8 above). Either fold them into the sprint-48 review decisions or schedule a small dedicated comment-cleanup task.
- `step-dispatch.ts` is the only sprint-48 module that overshoots its line budget (624 vs 400). Worth a dedicated task in a later sprint to extract `runBodyStep` and `handlePause` into their own files (FLAG-1).
- `progress/render.ts` is 34 lines over budget. The verbose accumulator is the natural extraction point (FLAG-5).
- The `authenticateProvider` name collision between `@ganderbite/relay-core` and `@ganderbite/relay/load-flow-and-auth.js` is small but real (FLAG-3). A rename of the CLI helper would close this without affecting behaviour.
- The flaky core tests `[ABORT-001]` and `[ABORT-002]` are now stable under coverage instrumentation (A.1). The third pre-existing flake — `state-save-failure` — was not in sprint 48 scope and remains tracked separately.
- The `mini-mock-flow` fixture directory lands under `packages/cli/tests/fixtures/` and is correctly scoped to test infra. The fixture's `package.json` carries `"private": true` and a `relay` metadata block — consistent with the flow-package format used elsewhere in the repo.
- `task_120` did not touch `answer.ts` because the file has no auth-only block. The lack of a `--provider` flag on `relay answer` means an operator who wants to override provider selection during answer-then-resume must do so via flow or global settings. Worth a small UX task to add `--provider` to `relay answer` for symmetry.
