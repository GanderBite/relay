# Sprint 17 Re-Review — Code-Review Fix Commit

**Reviewer:** `@code-reviewer (agent)`
**Commit reviewed:** `57a3477` refactor(core): address FLAG-1, FLAG-2, FLAG-3, FLAG-4, FLAG-5, FLAG-6 from sprint-17 review
**Summary:** 6/6 RESOLVED. No new BLOCK or FLAG introduced.

---

## Verdicts

### FLAG-1 · No unit tests for `claude-cli/translate.ts` — **RESOLVED**

- `packages/core/tests/providers/claude-cli/translate.test.ts` exists with 38 tests across 4 `describe` blocks (`translateCliMessage`, `extractResultSummary`, `mergeUsage`, and the tool id-correlation block).
- All branches called out in the finding are covered:
  - `stream_event` unwrap → `TRANSLATE-STREAM-001/002/003` (including missing inner event edge case).
  - Top-level `tool_use` → `TRANSLATE-TOOL-001/002`.
  - Top-level `tool_result` → `TRANSLATE-TOOL-003/004` (including `is_error: true`).
  - `result` with missing `stop_reason` → `TRANSLATE-RESULT-002` (asserts fallback to `'stream_completed'`).
  - `result` with empty-string `stop_reason` → `TRANSLATE-RESULT-003` (also falls back — defensive).
  - `extractResultSummary` `result.model` fallback → `SUMMARY-006`.
  - `mergeUsage` with missing fields in `b` → `MERGE-002` and `MERGE-003` (empty partial).
- `pnpm -F @relay/core test` passes 315 tests across 38 files.

### FLAG-2 · `message_delta` inner envelope handled by fall-through — **RESOLVED**

- `translate.ts` lines 216–219 now contain an explicit named branch:
  ```ts
  if (msgType === 'message_delta') {
    const usage = extractUsage(msg['usage']);
    return usage !== null ? [{ type: 'usage', usage }] : [];
  }
  ```
- The branch precedes the `assistant`/`user` handlers and the bottom-of-function top-level usage probe, so the behaviour is no longer dependent on fall-through.
- Covered by `TRANSLATE-MSGDELTA-001` and `TRANSLATE-MSGDELTA-002`.

### FLAG-3 · `ClaudeProviderKind` type and `providerKind` parameter vestigial — **RESOLVED**

- `inspectClaudeAuth()` signature is parameter-less: `export async function inspectClaudeAuth(): Promise<Result<AuthState, ClaudeAuthError>>` (auth.ts:66).
- `BuildEnvAllowlistOptions` only contains `extra?: Record<string, string>` — no `providerKind` (env.ts:79–86).
- `ClaudeProviderKind` type does not appear anywhere in `packages/core/src` or `packages/core/tests` (verified via grep).
- All call sites updated — `provider.ts` now calls `inspectClaudeAuth()` and `buildEnvAllowlist({ extra })` without a providerKind argument (provider.ts:106, 129–131).
- **Billing-safety guard is unconditional**: `SUPPRESS_CLI` is a module-level const used directly in `buildEnvAllowlist`; there is no longer any branch that could skip the `ANTHROPIC_API_KEY` suppression. Lines 109 (`const suppress = SUPPRESS_CLI;`) and 142–146 (force-set to `undefined` whether or not host env has it) run on every call.

### FLAG-4 · Stale "SDK" references in comments — **RESOLVED**

- The "Mirrors the SDK provider exactly" sentence is gone from `provider.ts`. The capabilities header now reads: `// run at race-load time, before any tokens are spent.` — provider-neutral.
- `types.ts` has no "SDK" references. All three call-out sites for FLAG-4 were updated.
- Two SDK mentions remain in the repo and are acceptable:
  - `translate.ts:9` — "stable regardless of any SDK" describes that the wire format is SDK-independent. This is the opposite of the original stale wording and is correct in context.
  - `errors.ts:450` — in `RateLimitError` docstring, describing that providers may surface "a rate-limit error from the underlying SDK". Scope: generic, not claude-specific; out of FLAG-4 scope.

### FLAG-5 · `providers/claude/` directory name stale — **RESOLVED**

- `packages/core/src/providers/claude/` does not exist (verified with `ls` and `find`).
- `auth.ts` and `env.ts` now live at `packages/core/src/providers/claude-cli/auth.ts` and `.../env.ts`.
- Matching test files moved to `packages/core/tests/providers/claude-cli/auth.test.ts` and `.../env.test.ts`; their src-path imports point at `../../../src/providers/claude-cli/env.js` (confirmed in env.test.ts:8).
- `provider.ts` imports are updated to the local paths `./auth.js` and `./env.js` (provider.ts:50, 52).
- `pnpm -F @relay/core typecheck` passes cleanly with no missing-import diagnostics.
- (Non-blocking: the stale `packages/core/dist/` artifact still references the old path in its sourcemap; this is expected stale build output and will be regenerated on the next `pnpm build`.)

### FLAG-6 · `stream.end` event missing `costUsd`/`sessionId` — **RESOLVED**

- `translate.ts` `result` branch (lines 188–210) now attaches both fields:
  - `costUsd` attached only when `typeof rawCost === 'number' && Number.isFinite(rawCost)` — the requested guard is present (line 201). Covered by `TRANSLATE-RESULT-004` (attach on valid number), `TRANSLATE-RESULT-007` (NaN skipped).
  - `sessionId` attached when `isString(rawSid)` (line 204–206). Covered by `TRANSLATE-RESULT-005`.
  - Both omitted when the envelope lacks them — `TRANSLATE-RESULT-006`.
- `provider.ts` now consumes `event.costUsd` from the `stream.end` event in the invoke() aggregator (lines 303–307) and drops the separate `extractTotalCostUsd` helper. `grep` confirms the helper is gone from both src and tests.
- The ordering invariant (usage before stream.end) is preserved and tested by `TRANSLATE-RESULT-008`.

---

## New BLOCK · 0

None.

## New FLAG · 0

None. Spot-checks of the refactor's peripheral surface:

- `isRecord` / `isString` helpers are duplicated between `provider.ts` (lines 361–363) and `translate.ts` (lines 28–30). This predates the fix commit and is not a regression.
- `provider.ts` still carries the `isPipelineError` duck-type guard — unchanged, also predates the fix.
- Dist artifact `packages/core/dist/` still references the old `providers/claude/auth.ts` path in its sourcemap. This is a stale build, not a source issue; next `pnpm build` regenerates.

## PASS — files confirmed correct

- `packages/core/src/providers/claude-cli/auth.ts` — parameter-less `inspectClaudeAuth()`, unconditional API-key rejection branch in `inspectCli`.
- `packages/core/src/providers/claude-cli/env.ts` — `SUPPRESS_CLI` always enforced; no providerKind branch.
- `packages/core/src/providers/claude-cli/translate.ts` — explicit `message_delta` branch; `result` branch carries `costUsd` + `sessionId` with `Number.isFinite` guard.
- `packages/core/src/providers/claude-cli/provider.ts` — imports moved to sibling files; capabilities comment is provider-neutral; invoke() pulls costUsd from the stream.end event.
- `packages/core/src/providers/types.ts` — no "SDK" wording; the `stream.end` event shape matches the new payload (`costUsd?: number; sessionId?: string`).
- `packages/core/tests/providers/claude-cli/translate.test.ts` — 38 tests covering all flagged branches, all passing.
- `packages/core/tests/providers/claude-cli/auth.test.ts` and `.../env.test.ts` — moved alongside the source, imports rewritten to the new path.
