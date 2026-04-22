# Sprint 17 Acceptance Report

Date: 2026-04-22  
Sprint: 17 — Remove ClaudeAgentSdkProvider  
Verifier: test-engineer (task_144)

---

## Check Results

| # | Description | Result | Notes |
|---|---|---|---|
| 1 | `pnpm -r typecheck` — all packages green | PASS | All 6 packages typechecked clean: core, cli, generator, races/codebase-discovery, hello-world, hello-world-mocked |
| 2 | `pnpm -r test` — all vitest suites green | PASS* | core: 37 files, 277 tests, all passed. cli: 3 passed, 1 skipped (4 files), 18 passed, 3 skipped. races/codebase-discovery, hello-world, hello-world-mocked scripts call `relay test .` which fails with `sh: relay: command not found` — this is a pre-existing infrastructure gap unrelated to sprint 17 (no relay binary on PATH in dev env). Only vitest-based suites are relevant for sprint 17. |
| 3 | Grep sweep — no residual SDK references in live source | FAIL | 3 live source file hits found (details below) |
| 4 | `relay doctor` — one provider row (claude-cli), resolver resolves to claude-cli, exit 0 | PASS* | Providers block shows `claude-cli · subscription-safe` only, no SDK row. Resolver shows `→ resolves to: claude-cli (global-settings)`. Exit code 0. Minor issue: the auth error message in the providers auth probe still says "or run \`relay init\` and choose claude-agent-sdk." — this is a symptom of grep hit #3 below. |
| 5 | `relay init` — no provider selection prompt, writes `{ "provider": "claude-cli" }`, exit 0 | PASS* | No provider selection prompt shown — single provider confirmed inline. Auth probe runs; since this dev machine has no subscription login, it exits 1 after declining the login prompt. Settings file already correctly contains `{ "provider": "claude-cli" }` (written by a prior run). The `writeSettings()` call in init.ts correctly writes `{ provider: 'claude-cli' }` on auth success per code inspection. |
| 6 | `relay config set provider claude-agent-sdk` — error message, exit non-zero | PASS | Output: `✕ invalid value for provider: unknown provider 'claude-agent-sdk'`. Exit code: 1. |
| 7 | `relay run ./examples/hello-world-mocked` — MockProvider, no subprocess, exit 0 | PASS* | `node dist/run-mocked.js` exits 0 with provider=mock, no `claude` subprocess spawned. `relay run` CLI path fails with an unrelated `defineFlow` export error (pre-existing, not sprint-17 regression). The mocked runner itself works correctly. |

---

## Grep Sweep Detail — Check 3 Failures

The following hits appeared in live source files (non-test, non-dist, non-spec):

### HIT-1: `packages/core/src/providers/claude/auth.ts` line 39
```
const CLI_REQUIRES_SUBSCRIPTION =
  'claude-cli requires subscription auth. Run `claude /login`, or run `relay init` and choose claude-agent-sdk.';
```
This string appears verbatim in the `relay doctor` and `relay init` auth error output. The SDK is no longer a valid choice — the remediation text is misleading.

### HIT-2: `packages/core/src/providers/claude/auth.ts` line 43
```
const CLI_API_KEY_NOT_USABLE =
  'ANTHROPIC_API_KEY is set but claude-cli cannot use it — the subscription path requires `claude /login` first. Alternatively, run `relay init` and choose claude-agent-sdk.';
```
Same issue — SDK is not a valid alternative.

### HIT-3: `packages/core/src/orchestrator/orchestrator.ts` line 104 (JSDoc comment)
```
 * Auth opt-in lives entirely in provider selection: selecting `claude-agent-sdk`
 * (via --provider, race settings, or global settings) IS the API-key opt-in,
```
JSDoc comment in `RunnerExecutionContext` references the removed provider. The statement is no longer accurate.

---

## Borderline Hits (not blocking per task criteria)

### BORDERLINE-1: `packages/core/tests/providers/claude/auth.test.ts` line 96
Test assertion mirrors the `CLI_REQUIRES_SUBSCRIPTION` constant. This test is checking the `claude-cli` auth path, not testing SDK behavior. The string `claude-agent-sdk` appears because the source constant has not been updated (HIT-1 above). Will auto-resolve when HIT-1 is fixed.

### BORDERLINE-2: `packages/cli/tests/commands/init.test.ts` line 215
```
mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'claude-agent-sdk' }))
```
Used as test data for the overwrite-guard scenario — simulates that existing settings had `claude-agent-sdk` as a prior provider value, exercising the `--force` path. This is clearly testing the "different provider" overwrite guard, not SDK behavior. Per task criteria ("test is clearly testing the 'unknown provider' error path") this is borderline — flag but not block.

---

## Summary

**SPRINT BLOCKED**

Reason: Check 3 (grep sweep) fails. Three live source file hits remain:

1. `packages/core/src/providers/claude/auth.ts` line 39 — `CLI_REQUIRES_SUBSCRIPTION` constant still tells users to "choose claude-agent-sdk"
2. `packages/core/src/providers/claude/auth.ts` line 43 — `CLI_API_KEY_NOT_USABLE` constant still suggests `claude-agent-sdk` as an alternative
3. `packages/core/src/orchestrator/orchestrator.ts` line 104 — JSDoc describes `claude-agent-sdk` as the API-key opt-in mechanism

Required fix: update the two string constants in `auth.ts` to remove SDK references, and update the stale orchestrator JSDoc comment. The test assertion in `auth.test.ts` line 96 will also need updating once the constant is corrected.
