# Sprint 17 · Remove ClaudeAgentSdkProvider — claude-cli as the sole execution path — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits `26a8ff3` (feat(core): remove ClaudeAgentSdkProvider — claude-cli as sole execution path), `41530e5` (feat(core): remove SubscriptionTosLeakError + purge remaining SDK test references), `5f2100c` (chore(core): acceptance pass — sweep residual SDK string references)
**Summary:** 0 BLOCK, 6 FLAG, 7 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## BLOCK · 0

None. The billing-safety guard (§8.1) and the translator-chain surgery were landed correctly: `ANTHROPIC_API_KEY` is unconditionally suppressed in the only remaining allowlist branch, no file in `packages/core/src/` still imports from `@anthropic-ai/claude-agent-sdk`, and `ClaudeCliProvider`'s new imports (`extractResultSummary`, `mergeUsage`, `translateCliMessage`) all resolve against the local `claude-cli/translate.ts`. `pnpm -F @relay/core typecheck` is clean.

---

## FLAG · 6

### FLAG-1 · No unit tests for the new `claude-cli/translate.ts` — 407 lines of deleted coverage were not relocated

- **File:** `packages/core/src/providers/claude-cli/translate.ts` (source), `packages/core/tests/providers/claude-cli/translate.test.ts` (missing)
- **Spec:** §4.6.3 rule 1 — "Translate, don't expose. A provider that uses snake_case fields internally MUST emit camelCase on the wire. Quirks stop at the provider boundary." Rule 2 — "Always populate `usage`, even if approximate."
- **Finding:** The task_140 plan moved `translateSdkMessage`, `extractSdkResultSummary`, and `mergeUsage` out of `claude/translate.ts` and into `claude-cli/translate.ts`. In the same commit (`26a8ff3`), two test files were deleted with no replacement:
  - `packages/core/tests/providers/claude/translate.test.ts` (162 lines, IDs `[TRANSLATE-001..]`) — covered `translateSdkMessage` content-block branches, `tool_result.is_error` truth table, `content_block_delta`, unknown-shape guards.
  - `packages/core/tests/providers/claude/translator.test.ts` (245 lines) — `extractSdkResultSummary` cases, `mergeUsage` arithmetic.

  The new `translateCore` / `translateCliMessage` / `extractResultSummary` / `mergeUsage` functions are exercised only indirectly by six `provider.test.ts` cases that walk happy paths through the full subprocess pipe. Many branches in `translateCore` have no test today:
  - The `stream_event` unwrap path.
  - `tool_use` / `tool_result` at the top level (not inside an assistant/user envelope).
  - `tool_result` with `is_error: true` → `ok: false`.
  - The `result` branch emitting `stream.end` with the `'stream_completed'` fallback when `stop_reason` is missing.
  - `extractResultSummary` with `model` falling back to `msg.result.model`.
  - `mergeUsage` with missing fields in `b`.
- **Suggested fix:** Port `packages/core/tests/providers/claude/translate.test.ts` and `translator.test.ts` into `packages/core/tests/providers/claude-cli/translate.test.ts`, updating imports to `../../../src/providers/claude-cli/translate.js` and renaming `translateSdkMessage` → `translateCliMessage`, `extractSdkResultSummary` → `extractResultSummary`. Both deleted files still exist under `git show 26a8ff3^:packages/core/tests/providers/claude/translate.test.ts` (and `translator.test.ts`); they can be rehydrated mechanically.
- **Decision:**

### FLAG-2 · `stream_event` wrapper's `message_delta` inner envelope is handled by the fall-through, not by a named branch

- **File:** `packages/core/src/providers/claude-cli/translate.ts:125-278`
- **Spec:** §4.6.3 rule 2 — "Always populate `usage`, even if approximate."
- **Finding:** `translateCore` has explicit branches for `system`, `turn_start` / `message_start`, `turn_end` / `message_stop`, `tool_use`, `tool_result`, `content_block_delta`, `result`, `assistant`, `user`. The Messages-API wire-level `message_delta` event (which carries per-message `usage` totals) is NOT listed by name. The fixture `FIXTURE_MESSAGE_DELTA` in `provider.test.ts:174-189` is of shape `{ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason, ... }, usage: { input_tokens, ... } } }`. When `translateCliMessage` unwraps the `stream_event` and hands `event` to `translateCore`, `msgType === 'message_delta'` matches none of the named branches and falls through to the final `extractUsage(msg['usage'])` branch at line 267. This happens to extract the usage (because `message_delta.usage` IS at the top of the inner event), so the test passes — but reliance on the fall-through is fragile: if a future envelope adds a `message_delta` with `usage` nested deeper, the usage will silently disappear, and the code reads as if `message_delta` is an "unrecognized shape" rather than a handled event.
- **Suggested fix:** Add an explicit branch:
  ```ts
  if (msgType === 'message_delta') {
    const usage = extractUsage(msg['usage']);
    return usage !== null ? [{ type: 'usage', usage }] : [];
  }
  ```
  This makes the handling self-documenting and decouples it from the bottom-of-function fall-through.
- **Decision:**

### FLAG-3 · `ClaudeProviderKind` type union has a single value; the `opts` parameter is essentially vestigial

- **File:** `packages/core/src/providers/claude/auth.ts:46-51`, `packages/core/src/providers/claude/env.ts:79-92,114-117`
- **Spec:** Memory rule "Keep it simple, don't reinvent the wheel" — prefer thin abstractions, kill dead ceremony.
- **Finding:** After the SDK branch was removed, `ClaudeProviderKind = 'claude-cli'` is a singleton union. Both files carry a `providerKind: ClaudeProviderKind` parameter plus a `void opts;` / `void opts.providerKind;` to silence the unused-parameter lint. Every call site in the codebase passes the same literal: `inspectClaudeAuth({ providerKind: 'claude-cli' })` and `buildEnvAllowlist({ providerKind: 'claude-cli', extra })`. The comments ("Reserved for future providers; currently only `'claude-cli'` is accepted") justify the shape, but the signature and the `void` statement are pure ceremony today and make the reader pause. Two identically-named `ClaudeProviderKind` types exported from different files also mildly harms discoverability.
- **Suggested fix:** Either (a) drop `providerKind` from both call sites and simplify the signatures to `inspectClaudeAuth(): Promise<Result<...>>` and `buildEnvAllowlist(opts: { extra?: Record<string, string> } = {}): Record<string, string | undefined>` — the next time a provider kind is added, reintroduce the parameter then, or (b) keep the parameter but consolidate the `ClaudeProviderKind` type into one place (e.g., `providers/claude/kinds.ts`) and re-export from both. Option (a) is cleaner and aligned with the memory rule.
- **Decision:**

### FLAG-4 · Stale SDK references in comments (`provider.ts`, `types.ts`) — the "SDK" no longer exists in this codebase

- **File:** `packages/core/src/providers/claude-cli/provider.ts:57-61`, `packages/core/src/providers/types.ts:203,208,214-219`
- **Spec:** Memory rule "Code comments must be self-contained" — comments should not refer to things that aren't present.
- **Finding:** Several comments still refer to "the SDK", "the SDK provider", or "re-reading the raw SDK payload":
  - `provider.ts:57-61`: "Capabilities — published to the Runner so static capability checks can run at race-load time, before any tokens are spent. Mirrors the SDK provider exactly: both backends ultimately drive the same `claude` binary." — There is no SDK provider anymore, so "Mirrors the SDK provider exactly" is a dangling reference.
  - `types.ts:203,208`: "Providers populate this when the SDK exposes a correlation id." — should be "when the wire envelope exposes a correlation id".
  - `types.ts:214-219`: "Terminal event emitted once by the provider when the SDK's final result message arrives. Carries the normalized stopReason so downstream callers aggregating a stream into an InvocationResponse can populate the required stopReason field without re-reading the raw SDK payload. The provider guarantees a non-empty string — it substitutes 'stream_completed' when the SDK omits stop_reason."
- **Suggested fix:** Replace "SDK" with "provider" or "stream envelope" in all six sites. Specific rewrites:
  - `provider.ts:59-61`: delete the "Mirrors the SDK provider exactly" sentence; the capability table stands on its own.
  - `types.ts:203,208`: "when the wire envelope exposes a correlation id".
  - `types.ts:214-219`: "when the provider's final `result` envelope arrives... without re-reading the raw payload. The provider guarantees a non-empty string — it substitutes 'stream_completed' when the envelope omits stop_reason."
- **Decision:**

### FLAG-5 · `packages/core/src/providers/claude/` directory name is stale — it holds only `auth.ts` + `env.ts`, both specific to `claude-cli`

- **File:** `packages/core/src/providers/claude/` (the directory), `packages/core/src/providers/claude-cli/provider.ts:40-41`
- **Spec:** §4.6.11 — "Each provider decides which env vars to pass through to its underlying transport." The guidance is per-provider; a directory named `claude/` now lives solely to serve one provider (`claude-cli`) yet sits as a sibling of `claude-cli/`, which confuses the module topology.
- **Finding:** After the SDK removal, `providers/claude/` contains only `auth.ts` (246 lines) and `env.ts` (169 lines). Both are imported by `ClaudeCliProvider` via `../claude/auth.js` / `../claude/env.js`. The naming suggests the directory holds *shared* plumbing for many Claude providers, but there is exactly one Claude provider and everything in this directory is scoped to it. A new contributor will reasonably wonder whether `claude/` is a half-renamed directory or an intentional split, and whether they should edit `claude/env.ts` or `claude-cli/process.ts` for a given change.
- **Suggested fix:** Two options, pick one:
  1. Move `auth.ts` and `env.ts` into `providers/claude-cli/` (same directory as `provider.ts`, `args.ts`, `process.ts`). Update the two imports. Delete `providers/claude/` entirely. This is the cleanest outcome and aligns the directory tree with the code's actual scope.
  2. Rename `providers/claude/` to `providers/shared-auth/` or similar if the intent is to share these with future Claude-backed providers. Given there are no such providers planned in the near term, option (1) is preferable.
- **Decision:**

### FLAG-6 · `stream.end` event's optional `costUsd`/`sessionId` fields are never populated by the translator

- **File:** `packages/core/src/providers/claude-cli/translate.ts:187-197`, `packages/core/src/providers/types.ts:221`
- **Spec:** §4.6.3 — normalized `InvocationResponse` carries `costUsd` and `sessionId`; the `stream.end` event in `InvocationEvent` declares them as optional fields, presumably so stream consumers can get parity with `invoke()`.
- **Finding:** The `InvocationEvent` type for `stream.end` is `{ type: 'stream.end'; stopReason: string; costUsd?: number; sessionId?: string }`. When `translateCore` sees a `result` envelope, it emits the `stream.end` event with only `stopReason` — the `costUsd` (via `total_cost_usd`) and `sessionId` (via `session_id`) are available in the same envelope (and in fact `extractResultSummary` and `extractTotalCostUsd` already know how to read them), but neither is attached to the `stream.end` event. This means a consumer using `provider.stream()` alone cannot populate `InvocationResponse.costUsd` / `sessionId` without re-reading the raw envelope — exactly the re-read the comment claims `stream.end` is supposed to eliminate.

  This is likely pre-existing behavior carried over from the old `claude/translate.ts`, not a regression introduced by sprint 17. Calling it out here because sprint 17 is the right moment to close the gap: the translator now lives with the CLI provider that actually emits the envelope, and both extractors (`extractResultSummary`, `extractTotalCostUsd`) are local helpers that can be factored into the translator.
- **Suggested fix:** In the `result` branch of `translateCore`, read `session_id` and `total_cost_usd` off the envelope and include them on the `stream.end` event when present:
  ```ts
  if (msgType === 'result') {
    const events: InvocationEvent[] = [];
    const usage = extractUsage(msg['usage']);
    if (usage !== null) events.push({ type: 'usage', usage });
    const rawStop = msg['stop_reason'];
    const stopReason = isString(rawStop) && rawStop.length > 0 ? rawStop : 'stream_completed';
    const streamEnd: Extract<InvocationEvent, { type: 'stream.end' }> = { type: 'stream.end', stopReason };
    const rawCost = msg['total_cost_usd'];
    if (typeof rawCost === 'number' && Number.isFinite(rawCost)) streamEnd.costUsd = rawCost;
    const rawSid = msg['session_id'];
    if (isString(rawSid)) streamEnd.sessionId = rawSid;
    events.push(streamEnd);
    return events;
  }
  ```
  Once the translator populates these fields, `extractTotalCostUsd` in `provider.ts` could be deleted in favour of reading the already-translated `stream.end` event.
- **Decision:**

---

## PASS · 7 (no action needed)

- `packages/core/src/providers/claude/env.ts`: §8.1 billing-safety contract is intact — `SUPPRESS_CLI = ['ANTHROPIC_API_KEY']` is applied unconditionally regardless of `providerKind`, the suppression loop force-emits `undefined` even when the host did not set the key, and caller-supplied `extra` overrides are applied last (tested by `[ENV-COMMON-004]`, `[ENV-CLI-002]`, `[ENV-CLI-003]`, `[ENV-CLI-006]`).
- `packages/core/src/providers/claude/auth.ts`: §8.1 guard preserved — the CLI branch still rejects an `ANTHROPIC_API_KEY`-only environment with `ClaudeAuthError("... claude-cli cannot use it — the subscription path requires `claude /login` first.")`, and the error carries `envObserved: ['ANTHROPIC_API_KEY']` so doctor output can introspect the leak surface. `ClaudeProviderKind` narrowed to `'claude-cli'` per task spec.
- `packages/core/src/providers/claude-cli/translate.ts`: the `stream_event` wrapper unwrap (lines 304-306) is correct; `translateCore` is pure, returns `[]` on any unknown/malformed shape, never throws (wrapped in try/catch at line 274). `extractResultSummary` returns `null` for non-`result` envelopes and preserves `stopReason: null` vs `undefined` semantics correctly. `mergeUsage` arithmetic is equivalent to the pre-sprint-17 implementation.
- `packages/core/src/providers/claude-cli/provider.ts`: call sites updated correctly — `extractSdkResultSummary` → `extractResultSummary`, the `mergeUsage` import now resolves locally, the response-construction block preserves the `summary?.numTurns ?? fallbackTurnCount` precedence and the `summary?.model ?? req.model ?? ''` fallback chain.
- `packages/core/src/providers/index.ts`: `registerDefaultProviders` now wires only `ClaudeCliProvider`; idempotent via `registerIfAbsent`. No residual SDK import.
- `packages/core/src/index.ts`: `ClaudeAgentSdkProvider`, `ClaudeAgentSdkProviderOptions`, and `SubscriptionTosLeakError` are no longer re-exported. `ClaudeCliProvider` is the sole provider re-export.
- `packages/core/package.json`: `@anthropic-ai/claude-agent-sdk` removed from `peerDependencies` (only `dependencies` — handlebars, neverthrow, p-retry, pino, pino-pretty, zod — remain). `pnpm-lock.yaml` had 930 deletions in the sprint-17 commit, consistent with the SDK and its transitive deps being pruned.

---

## Other follow-ups (out of sprint-17 scope)

- `packages/races/codebase-discovery/examples/sample-output.html:261` still contains the string "`@anthropic-ai/claude-agent-sdk`" inside an HTML `<td>` — this is a snapshot of a past race run, but if the catalog regenerates from this HTML the SDK reference will ship to users. Task_144's grep sweep description explicitly excluded `_work/`, `_specs/`, `dist/`, `node_modules/` but did NOT exclude `examples/sample-output.html`, so this is either a miss in the acceptance pass or an intentionally-retained artifact. Confirm with `@doc-writer` / `@catalog-builder` whether the sample HTML is regenerated from current source or frozen.
- `packages/cli/tests/commands/init.test.ts:215` still references `provider: 'claude-agent-sdk'` in a mock return value. The test name was out of task_143's scope per the review instructions ("NOT to check"), but flagging for the test-engineer: this test case either needs to be removed (the value is no longer valid) or repurposed to drive the "unknown provider" error path with a genuinely-unknown value (e.g., `'openai'`) per the task_141 contract (`config set provider claude-agent-sdk` must now return "unknown provider 'claude-agent-sdk'").
- Prior `error-discrimination.test.ts` (261 lines) was deleted alongside the SDK provider. Verify with the test-engineer whether any of those error-discrimination assertions are CLI-relevant (e.g., `PipelineError` subclass discrimination that `ClaudeCliProvider` now owns); if so, port them to `packages/core/tests/providers/claude-cli/`.
- The `detail` string for the credentials-present branch is `'subscription (interactive credentials)'`. The product spec §6 banner format likely expects `'Pro subscription via ~/.claude/.credentials.json'` or similar. Confirm with the product-spec text whether the detail wording needs to match the banner contract verbatim.
