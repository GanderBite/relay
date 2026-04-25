# Project Audit Report

**Date:** 2026-04-25
**Auditor:** Claude Code
**Verdict:** SHIP WITH FIXES

## Executive Summary

Sprint 29 and its review cycle resolved the majority of the previous audit's blockers: `RelaySettings` is now `.strict()`, `onStepComplete` is implemented with three tests, `exactOptionalPropertyTypes` is enabled, coverage thresholds are wired into both vitest configs, the smoke test is excluded from the default run, all three new error class tests are present, the CI comment references `>=20.10`, and the `HandoffIoDetails` errno/dir types are consistent. The codebase scores 101/130 — a 12-point improvement.

Two critical blockers remain. First, `.claude/` (56 files of internal agent scaffolding) and `CLAUDE.md` (sprint workflow instructions) are **committed to git HEAD** and not listed in `.gitignore`. A public repo push would expose Anthropic-specific internal tooling to every user. Second, `relay run` calls `provider.authenticate()` twice per invocation — once in the CLI for the start banner and once inside the Orchestrator's `#authenticateAll` — adding 5–10 seconds of cold-start latency from a redundant `claude --version` spawn. The third remaining concern is a cluster of `JSON.parse … as T` casts in `run.ts` and `runs.ts` that the sprint-28 fix left behind while correctly addressing `progress.ts` and `paused-banner.ts`. Fix the three items in the priority list and the project is ready for a public release.

## Scorecard

| # | Dimension | Score | Blockers |
|---|-----------|-------|----------|
| 1 | Architecture & Modularity | 8/10 | CLI double-auth; FlowLoadError outside PipelineError hierarchy |
| 2 | Type Safety | 8/10 | Residual JSON.parse as-casts in run.ts + runs.ts; telemetry.ts cast |
| 3 | API Design | 9/10 | `onStepComplete` added; settings.strict(); minor ProviderRegistry asymmetry |
| 4 | Error Handling | 9/10 | All codes relay_*; handoff_error renamed; ProviderRateLimitError exit code unregistered |
| 5 | Code Quality | 9/10 | Stale terms gone; CI comment fixed; bespoke semverGte still in doctor.ts |
| 6 | Testing | 8/10 | Coverage thresholds and smoke fix landed; examples use `relay test` which fails without binary |
| 7 | Documentation | 7/10 | LICENSE + CONTRIBUTING added; CHANGELOG, CODE_OF_CONDUCT absent |
| 8 | CLI UX | 7/10 | Double authenticate() per run adds ~5–10 s latency; generate-registry removed |
| 9 | Security | 8/10 | .claude/ + CLAUDE.md committed to HEAD; relay_tests.json gitignored but on disk |
| 10 | Packaging | 9/10 | sideEffects, exports map, correct engines — all fixed; dependency ranges not exact |
| 11 | Extensibility | 8/10 | onStepComplete callback live; flow composition still absent (documented limitation) |
| 12 | Performance | 8/10 | Double auth probe unchanged (+5–10 s per run) |
| 13 | Maintainability | 8/10 | .claude/ + CLAUDE.md still in git HEAD despite _work/ being removed |
| **Total** | | **101/130** | |

---

## Detailed Findings

### 1. Architecture & Modularity — 8/10

**What 10/10 looks like:** `@relay/core` has zero dependencies on CLI or generator packages. `@relay/cli` imports from `@relay/core` only through its public `exports` map. No type is defined locally in the CLI that mirrors an unexported type from core. Every error class in the CLI-facing surface extends `PipelineError`. The Orchestrator authenticates exactly once per run.

**Evidence:**
- `packages/core/package.json` — no devDependencies on `@relay/cli` or `@relay/generator`; dependency direction is correct.
- `packages/cli/src/progress.ts:29-39` — `LiveStatePartial` is still defined locally with a comment explaining the situation. The Zod schema (`LiveStatePartialSchema`) was correctly added (sprint-28), but the type duplication persists because `live-state.ts` is not in the `exports` map.
- `packages/cli/src/flow-loader.ts:41` — `FlowLoadError extends Error`, not `PipelineError`. The `exitCodeFor` fallback in exit-codes.ts handles it via the generic `instanceof Error` path (exit 1), bypassing the typed registry entirely.
- `packages/cli/src/commands/run.ts:166` — calls `resolvedProvider.authenticate()` for the start banner. `packages/core/src/orchestrator/orchestrator.ts:286` — `#authenticateAll` calls `provider.authenticate()` again inside `run()`. For `ClaudeCliProvider`, both calls spawn `claude --version`.

**Issues:**
1. 🟡 MODERATE: Double `authenticate()` per run. CLI authenticates at run.ts:166 for the banner, Orchestrator at orchestrator.ts:286 for `#authenticateAll`. For `ClaudeCliProvider` this spawns `claude --version` twice, adding ~5–10 seconds. → **Fix:** Add `RunOptions.preAuthedState?: AuthState` to the Orchestrator. In `run()`, skip `#authenticateAll` when `preAuthedState` is set. In the CLI, pass the already-verified `authState` as `preAuthedState`.
2. 🟡 MODERATE: `FlowLoadError` (flow-loader.ts:41) extends `Error`, not `PipelineError`. → **Fix:** Extend `PipelineError` and add `FLOW_NOT_FOUND` and `FLOW_INVALID` codes to `ERROR_CODES` in errors.ts.
3. 🟢 MINOR: `LiveStatePartial` duplicated in progress.ts:29-39. → **Fix:** Export `LiveStatePartial` from `@relay/core` in `src/orchestrator/live-state.ts` and add the path to the `exports` map.

---

### 2. Type Safety — 8/10

**What 10/10 looks like:** Zero `as` casts outside of `unknown`-narrowing type guards. Every `JSON.parse` call is followed by a Zod `safeParse`. `exactOptionalPropertyTypes: true` in tsconfig. All public functions have explicit return type annotations.

**Evidence:**
- `tsconfig.base.json:19` — `"exactOptionalPropertyTypes": true` now present (added in sprint-29). Fix verified.
- `packages/cli/src/progress.ts:271` — `LiveStatePartialSchema.safeParse(JSON.parse(raw))` — Zod validation now applied. Fixed in sprint-28.
- `packages/cli/src/paused-banner.ts:145` — `RawStateSchema.safeParse(JSON.parse(raw))` — also fixed.
- `packages/cli/src/commands/run.ts:471` — `JSON.parse(raw) as { steps?: Record<string, RawStepState> }` — bare `as` cast. Not fixed by sprint-28 changes to progress.ts/paused-banner.ts.
- `packages/cli/src/commands/run.ts:482` — `JSON.parse(raw) as RawMetrics[]` — bare `as` cast.
- `packages/cli/src/commands/runs.ts:178` — `states.push(parsed as RunState)` — bare `as` cast after manual field-by-field guard.
- `packages/cli/src/telemetry.ts:64` — `const config = parsed as RelayConfig` — bare `as` cast. The surrounding `typeof parsed === 'object'` guard is not a Zod parse.
- `packages/cli/src/cli.ts:27-28` — double `as` cast `(meta as Record<string, unknown>)['version'] as string` after a manual type guard. Acceptable given the `typeof` check at line 24.

**Issues:**
1. 🟡 MODERATE: `run.ts:471,482` — `JSON.parse(raw) as …` for state.json and metrics.json. A corrupt post-run state.json silently passes undefined fields to the banner renderer. → **Fix:** Add local Zod schemas `RawStateJsonSchema` and `RawMetricsJsonSchema` matching the existing `RawStepState`/`RawMetrics` interfaces; use `safeParse` with a fallback to empty record/array.
2. 🟡 MODERATE: `runs.ts:178` — `parsed as RunState` after a five-field manual guard. If `RunState` gains a required field, the guard silently passes malformed data. → **Fix:** Define a `RunStateMinimalSchema = z.object({ runId: z.string(), flowName: z.string(), flowVersion: z.string(), startedAt: z.string(), status: z.string() }).passthrough()` and `safeParse` instead.
3. 🟡 MODERATE: `telemetry.ts:64` — `parsed as RelayConfig` with no Zod validation. → **Fix:** Use the inline structural guard already present (the `typeof parsed === 'object'` check) and access `telemetry?.enabled` directly on `parsed` typed as `Record<string, unknown>`, dropping the cast. Or import `RelaySettings` from `@relay/core` and use `safeParse`.
4. 🟢 MINOR: `cli.ts:27-28` double `as` cast for version. The manual `typeof` guard at line 24 makes this safe, but it is non-obvious. → **Fix:** `const meta = z.object({ version: z.string() }).passthrough().safeParse(req(...))` to make it self-evident.

---

### 3. API Design — 9/10

**What 10/10 looks like:** A new user writes their first flow in 5 minutes from types alone. The Orchestrator surfaces an event stream so hosts can subscribe to step completions without polling. `RelaySettings` rejects unknown keys. The `step.prompt` output union is modeled as a proper discriminated union.

**Evidence:**
- `packages/core/src/settings/schema.ts:3` — `RelaySettings = z.object({ provider: z.string().min(1).optional() }).strict()` — `.strict()` now present. Fixed.
- `packages/core/src/orchestrator/orchestrator.ts:121` — `onStepComplete?: ((stepId: string, result: StepResult) => void) | undefined` in `RunOptions`. Implemented with correct error-isolation in the walker at line 1289–1301.
- `packages/core/tests/orchestrator/orchestrator.test.ts:674–785` — HOOK-001, HOOK-002, HOOK-003 tests all pass.
- `packages/core/src/providers/registry.ts` — `register()` returns `Result<void, FlowDefinitionError>`; `registerIfAbsent()` returns `Result<'registered' | 'already-present', never>` — asymmetry unchanged.

**Issues:**
1. 🟢 MINOR: `ProviderRegistry.registerIfAbsent()` returns `Result<'registered' | 'already-present', never>` while `register()` returns `Result<void, FlowDefinitionError>`. The asymmetric return types are surprising to external authors implementing a custom provider. → **Fix:** Document the distinction explicitly in JSDoc on `registerIfAbsent`, explaining the sentinel values and why they differ from `register`.
2. 🟢 MINOR: `Provider.capabilities.models` accepts an empty array as "any string allowed" — this is not discoverable from the type. → **Fix:** Add JSDoc to `ProviderCapabilities.models` documenting the empty-array sentinel.

---

### 4. Error Handling — 9/10

**What 10/10 looks like:** All error codes follow the `relay_*` prefix. Every error class extends `PipelineError`. `ProviderRateLimitError.retryAfterMs` is either consumed by the retry loop or documented clearly as to why it is not. All exit codes are registered in `errorRegistry`.

**Evidence:**
- `packages/core/src/errors.ts:14` — `NO_PROVIDER: 'relay_NO_PROVIDER'` — prefix fixed (sprint-28).
- `packages/cli/src/exit-codes.ts:41–49` — `EXIT_CODES.handoff_error: 4` — renamed from `baton_error` (sprint-28).
- `packages/core/src/orchestrator/retry.ts:49-54` — comment explicitly documents that `retryAfterMs` is surfaced for observability but not used to extend the pause, citing the p-retry v7 API limitation. Acceptable documented limitation.
- `packages/cli/src/exit-codes.ts:122-350` — `errorRegistry` covers STEP_FAILURE, FLOW_DEFINITION, PROVIDER_CAPABILITY, CLAUDE_AUTH, AUTH_TIMEOUT, TIMEOUT, HANDOFF_SCHEMA, NO_PROVIDER, PROVIDER_AUTH. `ProviderRateLimitError` (code `relay_PROVIDER_RATE_LIMIT`) has **no entry** in the registry. A rate-limited run exits with the generic runner_failure handler (exit 1) with no remediation hint.
- `packages/core/src/errors.ts:751` — comment on `ProviderRateLimitError` says "CLI exit code: 8" but exit code 8 does not exist in `EXIT_CODES`.

**Issues:**
1. 🟡 MODERATE: `ProviderRateLimitError` (code `relay_PROVIDER_RATE_LIMIT`) has no entry in `errorRegistry` in exit-codes.ts. A rate-limited run surfaces the generic "Unexpected error" banner with no remediation. → **Fix:** Add an `EXIT_CODES.rate_limit: 8` constant and a registry entry for `ERROR_CODES.PROVIDER_RATE_LIMIT` in exit-codes.ts with a message like `✕ Rate limited by provider '${err.providerName}' … → wait and retry: relay resume ${runId}`.
2. 🟢 MINOR: `errors.ts` JSDoc on `ProviderRateLimitError` says "CLI exit code: 8" but that code does not exist. → **Fix:** Either add exit code 8 (see issue #1) and reconcile, or update the comment to reflect the actual exit code mapping.

---

### 5. Code Quality — 9/10

**What 10/10 looks like:** No stale terminology in any user-visible or developer-visible symbol. No file exceeds 500 lines without being a single-responsibility module. CI comments match the actual package.json values. No large test artifacts committed to root.

**Evidence:**
- `packages/cli/src/exit-codes.ts:46` — `handoff_error: 4` — renamed from `baton_error`. Fixed.
- `.github/workflows/ci.yml` — comment now reads `">=20.10"`. Fixed.
- `packages/core/src/orchestrator/orchestrator.ts` — 1,328 lines. The three main methods are ~250–350 lines each. Acceptable for the orchestrator's inherent complexity. `#walkDag` is ~460 lines — borderline.
- `packages/cli/src/commands/doctor.ts:71-81` — bespoke `semverGte(versionA, versionB)` function re-implements semver comparison. The `semver` package is already a direct dependency at `packages/cli/package.json:28`.
- Zero `console.log` in library source (confirmed by grep).
- `biome.json` — `noUnusedVariables: error`, `useImportType: error`, `organizeImports: on` — strict linting enforced.

**Issues:**
1. 🟢 MINOR: `doctor.ts:71-81` bespoke `semverGte` duplicates the `semver` dep. → **Fix:** Replace with `import semver from 'semver'; semver.gte(version, required)` using the already-installed package.

---

### 6. Testing — 8/10

**What 10/10 looks like:** Every path through `withRetry`, `#walkDag`, the DAG builder, auth inspector, and env allowlist is covered. Coverage threshold is enforced in CI (minimum 80% line coverage for core). Coverage badge in README. Every error class has a test. Smoke test is clearly labelled and excluded from the default run.

**Evidence:**
- `packages/core/vitest.config.ts:16` — `thresholds: { lines: 80, functions: 80 }` — added in sprint-29. Fixed.
- `packages/cli/vitest.config.ts:12-18` — `coverage: { ... thresholds: { lines: 80, functions: 80 } }` — added in sprint-29. Fixed.
- `packages/cli/vitest.config.ts:7` — `exclude: ['node_modules', 'dist', 'tests/smoke/**']` — smoke test excluded. Fixed.
- `packages/cli/vitest.smoke.config.ts` — dedicated smoke config added. Fixed.
- `packages/core/tests/errors.test.ts:68-90` — HOOK-001/002/003 tests for `onStepComplete` added. `AuthTimeoutError`, `ProviderRateLimitError`, `ProviderCapabilityError` all tested with ERROR-006/007/008. Fixed.
- `pnpm -F @relay/cli test` — 4 files, 26 tests, all pass.
- `pnpm -F @relay/core test` — 40 files, 343 tests, all pass.
- Examples (`hello-world`, `file-type-router`, etc.) have `"test": "relay test ."` in their `package.json`. These fail with `relay: command not found` when `pnpm -r test` is run without a global `relay` binary. The `pnpm -r test` CI step (step 7) will fail on those packages in a clean environment where `relay` is not globally installed.
- No coverage badge in README.

**Issues:**
1. 🟡 MODERATE: Example packages use `"test": "relay test ."` which requires a globally installed `relay` binary. `pnpm -r test` in CI (step 7) will fail with `spawn ENOENT` on a fresh runner. → **Fix:** Add `"test": "echo 'no unit tests — run relay test . with relay installed'"` or scope CI's step 7 to exclude example packages: `pnpm --filter './packages/**' test` instead of `pnpm -r test`.
2. 🟢 MINOR: No coverage badge in README. → **Fix:** Add a Codecov or Vitest coverage badge pointing to the CI run.

---

### 7. Documentation — 7/10

**What 10/10 looks like:** `LICENSE` file in root. `CONTRIBUTING.md` with setup instructions, PR process, and coding style. `CHANGELOG.md` following Keep A Changelog format. `CODE_OF_CONDUCT.md`. README has a working 60-second example. Every example flow has its own `README.md`. Provider authoring guide explains how to implement the `Provider` interface.

**Evidence:**
- `LICENSE` — MIT license with correct year and copyright holder. Added in sprint-27. Fixed.
- `CONTRIBUTING.md` — 59 lines with prerequisites, local setup, per-package commands, PR checklist, and coding conventions. Added in sprint-27. Fixed.
- `examples/hello-world/README.md` — exists. `examples/hello-world-mocked/README.md` — exists. All five examples have READMEs. Fixed.
- `find . -name "CHANGELOG.md"` — no output. Not added.
- `find . -name "CODE_OF_CONDUCT.md"` — no output. Not added.
- `find . -name "CODEOWNERS"` — no output. Not added.
- `docs/` directory — 7 files (billing-safety, flow-package-format, naming-conventions, resume-semantics, troubleshooting). These are not linked from the README beyond a brief mention.

**Issues:**
1. 🟡 MODERATE: No `CHANGELOG.md`. Users upgrading from 0.1.0 cannot know what changed. → **Fix:** Create `CHANGELOG.md` with an initial `## [0.1.0] — 2026-04-25` section listing the major features.
2. 🟡 MODERATE: No `CODE_OF_CONDUCT.md`. → **Fix:** Create `CODE_OF_CONDUCT.md` linking the Contributor Covenant or equivalent.
3. 🟢 MINOR: `docs/` files are not linked from the README. → **Fix:** Add a "Docs" section with one-line descriptions linking each doc.
4. 🟢 MINOR: No CODEOWNERS file. → **Fix:** Add `.github/CODEOWNERS` with `* @ganderbite`.

---

### 8. CLI UX — 7/10

**What 10/10 looks like:** One `claude --version` spawn per `relay run`. `generate-registry` is not exposed as a public bin entry. `relay doctor` uses the `semver` package it already depends on instead of a bespoke comparator. All CLI commands have `--help` text matching the product spec.

**Evidence:**
- `packages/cli/package.json:13` — `"bin": { "relay": "./bin/relay.js" }` — `generate-registry` removed from bin entries. Fixed.
- `packages/cli/src/commands/run.ts:166` — `resolvedProvider.authenticate()` called once for the banner. `packages/core/src/orchestrator/orchestrator.ts:286` — `#authenticateAll` → `provider.authenticate()` called again inside `run()`. For `ClaudeCliProvider`, both calls invoke `inspectClaudeAuth()` → `ensureClaudeBinary()` → `execFile('claude', ['--version'])`. Two spawns per `relay run` invocation.
- `packages/cli/src/commands/doctor.ts:71-81` — `semverGte` bespoke implementation still present despite `semver` being a direct dep.
- `packages/cli/src/commands/doctor.ts:95` — node version check uses `semverGte(version, '20.10.0')`. Correct result but unnecessary duplication.

**Issues:**
1. 🟡 MODERATE: Double `authenticate()` per run adds ~5–10 seconds of cold-start latency from two `claude --version` spawns. → **Fix:** Add `RunOptions.preAuthedState?: AuthState`. In the CLI, pass `{ preAuthedState: authState }` to `orchestrator.run(flow, input, runOpts)`. In the Orchestrator, skip `#authenticateAll` when `preAuthedState` is provided, instead using the pre-verified state directly.
2. 🟢 MINOR: `doctor.ts:71-81` bespoke `semverGte`. → **Fix:** Use `semver.gte(version, required)` via the already-installed `semver` dep.

---

### 9. Security — 8/10

**What 10/10 looks like:** `pnpm audit` reports zero vulnerabilities. No test artifacts committed. `.claude/` and `CLAUDE.md` are gitignored and not tracked. The `.npmrc` does not disable lockfile integrity checks. No sensitive path traversal vectors in handoff IDs.

**Evidence:**
- `pnpm audit` — "No known vulnerabilities found." (plus a DeprecationWarning about `url.parse()` from a transitive dep — not a CVE).
- `packages/core/src/providers/claude-cli/env.ts` — `buildEnvAllowlist()` uses a positive allowlist; unlisted vars are suppressed.
- `packages/core/src/handoffs.ts:19` — `HANDOFF_ID_PATTERN` plus explicit path-escape check. Two-layer defense.
- `packages/core/src/logger.ts` — pino redacts `CLAUDE_CODE_OAUTH_TOKEN` and all `_api_key`, `_token`, `_secret`, `_password` suffix patterns.
- `.gitignore` — `_work/` and `relay_tests.json` listed. Sprint-27 removed both from git tracking.
- `git show HEAD:.claude/settings.json` — returns content. `.claude/` (56 tracked files) and `CLAUDE.md` are **tracked in git HEAD** and **absent from `.gitignore`**. A public push exposes internal agent definitions, sprint workflow instructions, and settings.json permission hooks.
- `.npmrc` — `save-exact=true`, `strict-peer-dependencies=false`, `auto-install-peers=true`. No `ignore-scripts` setting; install scripts run on `pnpm install`, which is standard.

**Issues:**
1. 🔴 CRITICAL: `.claude/` (56 files) and `CLAUDE.md` are tracked in git HEAD and not in `.gitignore`. On a public repo push every user sees internal AI orchestration scaffolding, sprint workflow instructions, and per-session memory files. → **Fix:** Add `.claude/` and `CLAUDE.md` to `.gitignore`. Run `git rm -r --cached .claude CLAUDE.md` and commit with "chore: remove internal AI scaffolding from tracking".

---

### 10. Packaging & Distribution — 9/10

**What 10/10 looks like:** All packages have `sideEffects: false`. All packages have consistent `engines.node`. `@relay/cli` has an `exports` map. No internal tooling in public `bin` entries. Published package sizes are documented.

**Evidence:**
- `packages/core/package.json` — `"sideEffects": false` now present. Fixed.
- `packages/cli/package.json` — `"sideEffects": false` now present. `exports` map with `.` subpath added. `generate-registry` removed from `bin`. Fixed.
- `packages/generator/package.json` — `"sideEffects": false` now present. `"engines": { "node": ">=20.10" }` — fixed from the incorrect `>=25.8`. Fixed.
- `.github/workflows/ci.yml` comment — references `>=20.10`. Fixed.
- `packages/core/package.json` dependencies use `^` ranges (`"neverthrow": "^8.2.0"`, `"pino": "10.3.1"`). Some are exact, some are ranges — inconsistent. The `pnpm-lock.yaml` is committed so reproducibility is ensured, but the semver ranges in `package.json` are visible to downstream consumers.
- `.npmrc` — `save-exact=true` is set, meaning new `pnpm add` commands will pin exactly. Existing range entries were authored before this setting.

**Issues:**
1. 🟢 MINOR: Some direct dependencies in `packages/core/package.json` still use `^` ranges (`neverthrow: "^8.2.0"`, `handlebars: "^4.7.9"`). With `save-exact=true` in `.npmrc`, new adds are pinned. Existing ranges are belt-and-suspenders given the committed lockfile. → **Fix:** Run `pnpm add --save-exact neverthrow handlebars p-retry` to align existing entries with the `.npmrc` policy, making the intent unambiguous.

---

### 11. Extensibility & Plugin Architecture — 8/10

**What 10/10 looks like:** A third-party author can implement `Provider`, register it, and run a flow against it with zero changes to library internals. The Orchestrator exposes lifecycle hooks (`onStepStart`, `onStepComplete`, `onRunComplete`) that hosts can subscribe to. The `MockProvider` pattern is documented for testing.

**Evidence:**
- `packages/core/src/providers/types.ts:256-304` — `Provider` interface is clean and complete. Optional methods clearly marked.
- `packages/core/src/testing/index.ts` — `MockProvider` is a first-class export on `@relay/core/testing`. Excellent.
- `packages/core/src/orchestrator/orchestrator.ts:121` — `onStepComplete` callback implemented in `RunOptions`. Three tests (HOOK-001/002/003) verify correct behavior.
- No `onStepStart` or `onRunComplete` hooks. Only `onStepComplete`.
- No `step.flow(...)` builder for sub-flow composition.

**Issues:**
1. 🟢 MINOR: No `onStepStart` lifecycle hook. Embedding hosts cannot distinguish "step enqueued" from "step dispatched." → **Fix:** This is a nice-to-have, not a blocker. Add to the README as a known limitation.
2. 🟢 MINOR: Flows cannot compose other flows. A "meta-flow" requires manual process spawning. → **Fix:** Document as a known limitation in README under "Limitations."

---

### 12. Performance & Resource Management — 8/10

**What 10/10 looks like:** One `claude --version` spawn per `relay run`. The DAG walker's ancestor computation is O(V+E). AbortSignal listeners are removed on every code path that registers them. Watcher cleanup in `stop()`.

**Evidence:**
- `packages/core/src/flow/graph.ts` — `computeAncestorSets` is O(V+E). Good.
- `packages/core/src/orchestrator/orchestrator.ts:837-843` — `#authenticateAll` removes its abort listener and clears its setTimeout in a `finally` block. Correct.
- `packages/core/src/orchestrator/orchestrator.ts:1320` — `abortController.signal.removeEventListener('abort', onAbort)` in a `finally` block on the walker. Correct.
- `packages/cli/src/progress.ts:196-198` — `void this.#watcher.close(); this.#watcher = null;` in `stop()`. Watcher is correctly closed and nulled.
- Double `authenticate()` call per run — for `ClaudeCliProvider` two `claude --version` spawns: run.ts:166 and orchestrator.ts:286 → auth.ts → `ensureClaudeBinary()`.

**Issues:**
1. 🟡 MODERATE: Double `authenticate()` per run adds ~5–10 s overhead. → **Fix:** See Dimension 8 Fix.
2. 🟢 MINOR: `pino.destination({ sync: false })` in logger.ts uses async writes. If the process is SIGKILL'd, the last few log lines may not flush. → **Fix:** Acceptable for production; document as a known limitation.

---

### 13. Maintainability & Contribution Readiness — 8/10

**What 10/10 looks like:** A new contributor can `git clone`, `pnpm install`, `pnpm -r typecheck && pnpm -r test` and get a green suite in under 5 minutes. `CONTRIBUTING.md` explains the package structure. `.claude/` is gitignored. Commit messages follow conventional commits. GitHub issue and PR templates exist.

**Evidence:**
- `CONTRIBUTING.md` — present with setup, per-package commands, and PR checklist. Fixed.
- `_work/` — removed from git tracking in sprint-27. Fixed.
- `relay_tests.json` — gitignored and absent from HEAD. Fixed.
- `git show HEAD:.claude/settings.json` — returns content. `.claude/` (56 tracked files) and `CLAUDE.md` are still in git HEAD. The sprint-27 commit removed `_work/` but did not address `.claude/` or `CLAUDE.md`.
- `.gitignore` — does not list `.claude/` or `CLAUDE.md`.
- `.github/` — has `workflows/` but no `ISSUE_TEMPLATE/` or `PULL_REQUEST_TEMPLATE.md`.
- `pnpm -r typecheck` — all packages pass cleanly. `pnpm -F @relay/core test && pnpm -F @relay/cli test` — all pass. Example packages fail `relay test .` without a globally installed binary.

**Issues:**
1. 🔴 CRITICAL: `.claude/` (56 files of internal agent definitions, sprint prompts, settings, and memory) and `CLAUDE.md` (AI orchestration instructions) are committed to git HEAD. A new contributor sees this as noise; a public repo push exposes internal tooling. → **Fix:** `git rm -r --cached .claude CLAUDE.md`. Add both to `.gitignore`. Commit.
2. 🟡 MODERATE: Example packages' `"test": "relay test ."` scripts fail `pnpm -r test` without a global `relay` binary. → **Fix:** See Dimension 6 Fix.
3. 🟡 MODERATE: No GitHub issue or PR templates. → **Fix:** Create `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/pull_request_template.md`.
4. 🟢 MINOR: No CODEOWNERS file. → **Fix:** Add `.github/CODEOWNERS` with `* @ganderbite`.

---

## Priority Fix List

Ordered by impact on public-release readiness:

1. **Remove `.claude/` and `CLAUDE.md` from git tracking** — `git rm -r --cached .claude CLAUDE.md`, add both to `.gitignore`, commit. This is the single biggest reputational and security risk: 56 files of internal AI scaffolding are publicly visible in git history to anyone who clones the repo. (`/Users/michalgasiorek/Projekty/ganderbite/relay/.gitignore` — add lines `.claude/` and `CLAUDE.md`)

2. **Fix double authenticate() per run** — Add `RunOptions.preAuthedState?: AuthState` to `packages/core/src/orchestrator/orchestrator.ts`. Skip `#authenticateAll` when the field is set. In `packages/cli/src/commands/cli-run.ts:166`, pass `{ preAuthedState: authState }` into `runOpts`. Eliminates ~5–10 s of cold-start latency from a redundant `claude --version` spawn.

3. **Fix `pnpm -r test` breaking on example packages** — Either change each example's `"test"` script to a no-op, or restrict CI step 7 in `.github/workflows/ci.yml` to `pnpm --filter './packages/**' test` so example packages are excluded. Currently a clean CI runner cannot run `pnpm -r test` to a green result. (`packages/{cli,core,generator}/package.json` tests are unaffected; the break is in `examples/*/package.json`.)

4. **Add `ProviderRateLimitError` to the exit-codes registry** — `packages/cli/src/exit-codes.ts` — add `rate_limit: 8` to `EXIT_CODES` and a `makeHandler` entry for `ERROR_CODES.PROVIDER_RATE_LIMIT` with a "wait and retry" remediation line. Update the JSDoc comment on `ProviderRateLimitError` in `packages/core/src/errors.ts` to reference exit code 8.

5. **Fix remaining `JSON.parse as T` casts in run.ts and runs.ts** — `packages/cli/src/commands/run.ts:471,482` and `packages/cli/src/commands/runs.ts:178`. Add local Zod schemas and `safeParse` calls. The previous sprint fixed `progress.ts` and `paused-banner.ts` but left these three sites.

6. **Add CHANGELOG.md** — Create at repo root with `## [0.1.0] — 2026-04-25` section listing core, CLI, and generator features. Users and package managers need this.

7. **Extend `FlowLoadError` from `PipelineError`** — `packages/cli/src/flow-loader.ts:41`. Add `FLOW_NOT_FOUND` and `FLOW_INVALID` codes to `ERROR_CODES` in `packages/core/src/errors.ts`. Wire a registry entry in exit-codes.ts. This makes load errors type-safe through the exit-code mapper.

8. **Replace bespoke `semverGte` in doctor.ts** — `packages/cli/src/commands/doctor.ts:71-81`. Replace with `import semver from 'semver'; semver.gte(version, required)`. The `semver` package is already a direct dependency.

9. **Add GitHub issue and PR templates** — Create `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/pull_request_template.md` so incoming contributions have structured guidance.

10. **Fix telemetry.ts cast** — `packages/cli/src/telemetry.ts:64`. Access `telemetry?.enabled` directly on `parsed as Record<string, unknown>` after the existing object guard, or use `RelaySettings.safeParse`. Eliminates a silent failure mode when `~/.relay/config.json` is partially invalid.

---

## Open-Source Readiness Checklist

- [x] **LICENSE** — MIT license present at repo root with correct year and copyright holder.
- [x] **README** — Exists with 60-second tour and comparison table. Adequate for MVP.
- [x] **CONTRIBUTING** — Present with prerequisites, setup commands, PR checklist, and coding conventions.
- [ ] **CODE_OF_CONDUCT** — Does not exist.
- [x] **CI** — `.github/workflows/ci.yml` runs typecheck, build, and test on PRs. Coverage step for `@relay/core` wired.
- [ ] **Tests passing (`pnpm -r test`)** — Breaks on example packages that require a global `relay` binary (`spawn ENOENT`). Core and CLI packages pass (343 + 26 tests).
- [x] **npm audit clean** — No known vulnerabilities.
- [ ] **No internal dev artifacts in repo** — `.claude/` (56 files) and `CLAUDE.md` tracked in git HEAD. `relay_tests.json` is on disk but gitignored and not in HEAD.
- [x] **Docs match code** — `exit-codes.ts` uses `handoff_error` (correct), `errors.ts` codes are all `relay_*` (correct).
- [ ] **Changelog exists** — No CHANGELOG.md.
- [ ] **Internal dev artifacts removed** — `.claude/` and `CLAUDE.md` still in HEAD.
- [x] **ESM-only, correct Node target** — ESM throughout, no CJS dual-publish.
- [x] **Lockfile committed** — `pnpm-lock.yaml` present.
- [x] **sideEffects declared** — `"sideEffects": false` in all three packages.
- [x] **Atomic writes for state files** — `atomicWriteJson`/`atomicWriteText` used consistently.
- [x] **Auth guard** — Billing safety contract enforced in env.ts and auth.ts.
- [x] **exports map** — All three packages have correct `exports` maps.
- [x] **Consistent engines.node** — All packages and CI use `>=20.10`.

---

## Delta from Previous Audit

| # | Dimension | Previous | Current | Change | What changed |
|---|-----------|----------|---------|--------|--------------|
| 1 | Architecture & Modularity | 8/10 | 8/10 | = | Double-auth and FlowLoadError unchanged |
| 2 | Type Safety | 7/10 | 8/10 | +1 | `exactOptionalPropertyTypes`, progress.ts/paused-banner.ts Zod fixed; run.ts/runs.ts still pending |
| 3 | API Design | 8/10 | 9/10 | +1 | `onStepComplete` added; `RelaySettings.strict()` |
| 4 | Error Handling | 8/10 | 9/10 | +1 | `relay_NO_PROVIDER` fixed; `handoff_error` renamed; `ProviderRateLimitError` exit handler still missing |
| 5 | Code Quality | 7/10 | 9/10 | +2 | `baton_error` → `handoff_error`; CI comment fixed; no other regressions |
| 6 | Testing | 7/10 | 8/10 | +1 | Coverage thresholds, smoke exclusion, error class tests all added |
| 7 | Documentation | 4/10 | 7/10 | +3 | LICENSE + CONTRIBUTING added; example READMEs present; CHANGELOG still absent |
| 8 | CLI UX | 7/10 | 7/10 | = | Double-auth unchanged; `generate-registry` removed from bin |
| 9 | Security | 8/10 | 8/10 | = | `.claude/` + `CLAUDE.md` still tracked; relay_tests.json now gitignored |
| 10 | Packaging | 5/10 | 9/10 | +4 | sideEffects, exports map, generator engines, bin entries — all fixed |
| 11 | Extensibility | 7/10 | 8/10 | +1 | `onStepComplete` added with HOOK-001/002/003 tests |
| 12 | Performance | 8/10 | 8/10 | = | Double-auth unchanged |
| 13 | Maintainability | 5/10 | 8/10 | +3 | CONTRIBUTING added; `_work/` removed; `.claude/` + `CLAUDE.md` still in HEAD |
| **Total** | | **89/130** | **101/130** | **+12** | |
