# Sprint 4 · ClaudeProvider — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits `4dff0db` (auth/env/translate/zod-to-json + Result-flip) and `5b8da3d` (ClaudeProvider).
**Summary:** 1 BLOCK, 20 FLAG, 19 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## BLOCK · 1

### BLOCK-1 · env allowlist does not actually restrict the subprocess env

- **File:** `packages/core/src/providers/claude/provider.ts:133-144`
- **Spec:** §4.6.11 ("drops everything else"), §8.1 containment
- **Finding:** The `@anthropic-ai/claude-agent-sdk` v0.2.112 merges `options.env` on top of `process.env` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:63,105`; `sdk.d.ts:1059-1077`). The SDK only deletes a small fixed set of internal-marker vars (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`, `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT`, `GITHUB_ACTIONS`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`); `ANTHROPIC_API_KEY` is never dropped. Since `buildEnvAllowlist` returns the keys we want to keep but the SDK merges on top of the full parent env, our allowlist adds nothing that wasn't already there and subtracts nothing. The §4.6.11 "drops everything else" contract and the §8.1 containment strategy are both silently defeated: on the `allowApiKey=true` path `ANTHROPIC_API_KEY` reaches the subprocess whether or not it was present; arbitrary other secrets (`AWS_*`, `OPENAI_API_KEY`, caller env) leak through unconditionally.
- **Suggested fix:** Compute `process.env` minus allowlist and set every excluded key to `undefined` in the object handed to `options.env` (the SDK docstring explicitly says `undefined` values remove an inherited var).
  ```ts
  const built = buildEnvAllowlist({...});
  const envForSdk: Record<string, string | undefined> = { ...built };
  for (const key of Object.keys(process.env)) {
    if (!(key in built)) envForSdk[key] = undefined;
  }
  ```
  Pair with a regression test: `ANTHROPIC_API_KEY` in parent env + `allowApiKey=false` → the key does not appear in the child spawn env.
- **Decision:** fix now

---

## FLAG · 20

### FLAG-1 · `relay_ALLOW_API_KEY` casing diverges from every other canonical artifact

- **File:** `packages/core/src/providers/claude/auth.ts:27, 66, 129` (and the remediation string)
- **Spec:** `.claude/skills/billing-safety/SKILL.md` §8.1.2 (uppercase `RELAY_ALLOW_API_KEY`); `.claude/skills/claude-agent-sdk/SKILL.md:73`; `.claude/skills/vitest/SKILL.md:102,116`; `.claude/agents/systems-engineer.md:46`; `.claude/agents/test-engineer.md:51`; `.claude/skills/billing-safety/references/auth-threat-model.md:13,42,46` — all uppercase.
- **Finding:** `auth.ts` uses `relay_ALLOW_API_KEY` (lowercase `relay_`). Every other canonical artifact uses POSIX-conventional `RELAY_ALLOW_API_KEY` (uppercase). The only artifact that spells the lowercase form is `_work/sprint-4.json`'s task_26 description. When the `test-engineer` lands in a later wave and follows its own table, env tests will miss this code path.
- **Suggested fix:** Rename to `RELAY_ALLOW_API_KEY` everywhere in `auth.ts` (env check + remediation message). Amend `_work/sprint-4.json` via the spec-escalation path if it counts as the source of truth.
- **Decision:** fix now

### FLAG-2 · `ensureClaudeBinary` scrubs env to PATH-only; Windows / config-path lookups may spuriously fail

- **File:** `packages/core/src/providers/claude/auth.ts:161-165`
- **Spec:** None direct — operational concern.
- **Finding:** Setting `env: { PATH: process.env.PATH ?? '' }` on `execFile` is good for reproducibility but Windows uses `Path` and `claude --version` may consult `HOME`/`USERPROFILE` for user config. Could produce false "claude not found" with a misleading install remediation on some machines.
- **Suggested fix:** Mirror the `ALLOWLIST_EXACT` list used by `buildEnvAllowlist` (PATH, HOME, USER, LANG, LC_ALL, TZ, TMPDIR, SHELL) for the preflight check, or at least pass through `HOME` / `USERPROFILE`.
- **Decision:** fix now - create proper preflight

### FLAG-3 · `claude --version` preflight timeout is 3s; canonical skill says 5s

- **File:** `packages/core/src/providers/claude/auth.ts:56`
- **Spec:** `.claude/skills/claude-agent-sdk/SKILL.md:74` says 5-second timeout.
- **Finding:** 3s vs 5s is marginal but a cold bun-packaged binary could realistically miss 3s and produce a false negative.
- **Suggested fix:** Bump to 5000 ms or update the skill to match.
- **Decision:** fix now - Bump to 5000 ms

### FLAG-4 · `buildEnvAllowlist` return signature lies about what it actually provides

- **File:** `packages/core/src/providers/claude/env.ts:91`
- **Spec:** §4.6.11
- **Finding:** Function returns `Record<string, string>` implying a complete authoritative env. Its actual consumer hands it to the SDK's `options.env` which merges on top of `process.env` (see BLOCK-1). The "drop everything else" contract is defeated at the call site.
- **Suggested fix:** Either surface the "suppress" side explicitly — return `{ include, suppress }` — or change the function to return `Record<string, string | undefined>` where every non-allowlisted `process.env` key is set to `undefined`. Fix coupled with BLOCK-1.
- **Decision:** fix now

### FLAG-5 · `tool.result` always emits `name: 'unknown'`

- **File:** `packages/core/src/providers/claude/translate.ts:155, 221`
- **Spec:** §4.6.3 `{ type: 'tool.result'; name: string; ok: boolean }`
- **Finding:** The translator cannot resolve `tool_use_id → name` without state across calls. Downstream consumers that filter/route on `name` will see every tool result labeled `'unknown'`.
- **Suggested fix:** Either have the Provider own the id→name map and resolve post-translation, or add an optional `toolUseId` field to the event so the runner can reconcile.
- **Decision:** fix now - pick cleanest solution

### FLAG-6 · Turn counting from `message_start` / `message_stop` is unreliable

- **File:** `packages/core/src/providers/claude/translate.ts:132-138` → `provider.ts:260`
- **Spec:** §4.6.3 (turn events), §4.6.8 (numTurns)
- **Finding:** SDK emits `message_start` on the first user message (not always a turn) and multi-turn sessions can have multiple `assistant` messages without `message_stop`. Counting `turn.end` events to populate `InvocationResponse.numTurns` can over-count or under-count by SDK version.
- **Suggested fix:** Prefer the SDK's `result` message's `num_turns` field when present; fall back to counting.
- **Decision:** fix now - for anything AI related SDK is the source of truth

### FLAG-7 · Default `turn` value is 1 when SDK omits the field

- **File:** `packages/core/src/providers/claude/translate.ts:101-105`
- **Spec:** §4.6.3
- **Finding:** Combined with FLAG-6, multiple `turn.start` events can collide at `turn: 1`. Cosmetic for the aggregator but affects live display ordering.
- **Suggested fix:** Track monotonic turn counter in the Provider rather than defaulting here.
- **Decision:** Again SDK is the source of truth our code must not assume anything around it

### FLAG-8 · Assistant message with usage silently drops content blocks

- **File:** `packages/core/src/providers/claude/translate.ts:180-191, 196-199`
- **Spec:** §4.6.3
- **Finding:** If an assistant message arrives with both `usage` AND content, the translator returns the `usage` event and never walks the content. The one-event-per-call contract causes this; the comment acknowledges it but the provider passes raw messages in without per-block decomposition — so text in those messages is lost to the aggregator.
- **Suggested fix:** Either have the translator return an array of events, or decompose multi-block messages in the provider before calling translate.
- **Decision:** fix now - pick the cleanest solution

### FLAG-9 · `buildSdkOptions` log statement is a hidden side effect

- **File:** `packages/core/src/providers/claude/provider.ts:177`
- **Spec:** Not a spec concern; hygiene.
- **Finding:** Function named/commented as pure option construction but logs "claude stream opening" partway through.
- **Suggested fix:** Move the log to `stream()` immediately after the options build.
- **Decision:** fix now

### FLAG-10 · Cost math uses Sonnet-tier prices for every model

- **File:** `packages/core/src/providers/claude/provider.ts:103-119`
- **Spec:** §4.7 allows a single estimate (informational).
- **Finding:** Prices are Sonnet 4 tier (input $3/M, output $15/M). Running `opus-4-7` or `haiku-4-5` mis-estimates in both directions; comment claims "conservative upper bounds" which is not true for Opus.
- **Suggested fix:** Key prices off `req.model`, or widen defaults to Opus rates ($15 / $75) to stay truly upper-bound.
- **Decision:**: I don't know if we should make any billing estimates. from UX I think it's better to not show anything that to show information that is not truthful.

### FLAG-11 · `model` fallback `'claude'` is not a valid model id

- **File:** `packages/core/src/providers/claude/provider.ts:286`
- **Spec:** §4.6.8
- **Finding:** `model: req.model ?? 'claude'` — `'claude'` is not a member of `capabilities.models` and would fail any downstream `models.includes(response.model)` check.
- **Suggested fix:** Default to `'sonnet'` (SDK default) or read the actual model from the SDK result envelope.
- **Decision:**: fix now read the actual model

### FLAG-12 · `stopReason` hard-coded to `null`

- **File:** `packages/core/src/providers/claude/provider.ts:287`
- **Spec:** §4.6.3 (`stopReason: string | null`)
- **Finding:** SDK's `result` message carries `stop_reason` but the translator ignores it. Downstream runners lose the ability to distinguish "finished cleanly" from "hit budget cap" or "hit max turns".
- **Suggested fix:** Capture `stop_reason` from the final SDK `result` message in `translate.ts` and plumb through to `InvocationResponse`.
- **Decision:** fix now

### FLAG-13 · `raw: lastEvent` is a translated event, not the raw SDK payload

- **File:** `packages/core/src/providers/claude/provider.ts:288`
- **Spec:** §4.6.3 — `raw` docstring says _"Raw provider-specific payload, preserved for debugging"_.
- **Finding:** `lastEvent` is an already-normalized `InvocationEvent`, not the raw SDK message. Field contract violated.
- **Suggested fix:** Capture the raw SDK message alongside the translated event and store the raw one, or rename the field.
- **Decision:**: fix now - capture the raw sdk message

### FLAG-14 · `timeoutMs`, `providerOptions`, `sessionId` are not wired through

- **File:** `packages/core/src/providers/claude/provider.ts` (general)
- **Spec:** §4.6.3
- **Finding:** `InvocationRequest.timeoutMs` declared but not propagated to the SDK. `InvocationRequest.providerOptions` is the "escape hatch" and is silently dropped. `InvocationResponse.sessionId` extractable from SDK result envelope but never set.
- **Suggested fix:** Map each field to the corresponding SDK option / response field. None are required for v1 but combined with FLAG-12 / FLAG-13 the InvocationResponse is noticeably thinner than §4.6.3 implies.
- **Decision:**: Fix now - map the fields properly

### FLAG-15 · Self-registration makes user-constructed providers conflict

- **File:** `packages/core/src/providers/claude/provider.ts:311`
- **Spec:** §4.6.8
- **Finding:** Merely importing `@relay/core` populates `defaultRegistry` with a `ClaudeProvider({})`. A consumer who wants to register their own `ClaudeProvider({ allowApiKey: true })` gets `FlowDefinitionError: provider "claude" already registered` unless they check `has('claude')` first.
- **Suggested fix:** Expose `defaultRegistry.unregister()` or gate self-registration behind an explicit `registerDefaultProviders()` call.
- **Decision:** fix now - pick what is cleanest

### FLAG-16 · `ClaudeProviderOptions.allowApiKey` doc understates effect

- **File:** `packages/core/src/providers/claude/provider.ts:46-49`
- **Spec:** §8.1 voice
- **Finding:** Doc says "Omit or set to false to enforce subscription billing." Actual effect of `allowApiKey=false` is that `ANTHROPIC_API_KEY`-presence triggers a hard `err`, not just "enforce".
- **Suggested fix:** Rephrase: "Omit or set to false to block runs when `ANTHROPIC_API_KEY` is present in the environment."
- **Decision:** fix now

### FLAG-17 · SDK-boundary `as Record<string, unknown>` cast is avoidable

- **File:** `packages/core/src/providers/claude/provider.ts:166`
- **Spec:** Code quality / strict mode.
- **Finding:** `InvocationRequest.jsonSchema: object` is wider than `Record<string, unknown>` (the SDK's `JsonSchemaOutputFormat.schema` field type). The cast is defensible but tightening the core type removes it entirely.
- **Suggested fix:** Change `InvocationRequest.jsonSchema?: Record<string, unknown>` in `providers/types.ts`.
- **Decision:** fix now

### FLAG-18 · `AuthState.ok: boolean` is redundant with the Result wrapper

- **File:** `packages/core/src/providers/types.ts:86`
- **Spec:** §4.6.2
- **Finding:** Now that `authenticate()` returns `Result<AuthState, _>`, the success/failure signal lives in the Result branch. `inspectClaudeAuth` always sets `ok: true` on the `ok(...)` branch. Consumers pattern-match on `result.isOk()` and never look at `AuthState.ok`.
- **Suggested fix:** Drop `AuthState.ok` (breaks back-compat on a frozen type — requires spec decision), or document it as retained for compatibility only.
- **Decision:** We must be smart about when to user Result and when to actually throw an error. Anything client facing must throw error. All internal code must use Result pattern.

### FLAG-19 · MockProvider.stream duplicates response-factory work

- **File:** `packages/core/src/testing/mock-provider.ts:69-86`
- **Spec:** Not a spec concern.
- **Finding:** `stream()` internally calls `invoke()`. A test that calls both on the same MockProvider will run the configured response factory twice. Side-effects (counters, spies) fire twice.
- **Suggested fix:** Have `stream()` synthesize events directly from the configured response rather than routing through `invoke()`.
- **Decision:** fix now

### FLAG-20 · `registry.ts` still throws — pre-existing violation of the no-throw rule

- **File:** `packages/core/src/providers/registry.ts:9, 17`
- **Spec:** Project-wide neverthrow rule adopted this sprint.
- **Finding:** `register()` throws `FlowDefinitionError` on duplicate name; `get()` throws on unknown name. Not part of the sprint-4 delta but a follow-up must file it.
- **Suggested fix:** Flip both to return `Result<_, FlowDefinitionError>`; update callers.
- **Decision:** fix now

---

## PASS · 19 (no action needed)

For transparency:

- `auth.ts`: precedence table, Result wrapping, no throws, API-account warning text, cloud-routing short-circuit, remediation message (except env-var casing in FLAG-1).
- `env.ts`: allowlist constants match the canonical list, merges `extra` last, never mutates `process.env`, drops undefined values.
- `translate.ts`: snake_case → camelCase mapping exact, no `any`/`as`, never throws, `mergeUsage` NaN-safe, handles all §4.6.3 variants.
- `provider.ts`: `authenticate()` delegates to `inspectClaudeAuth`, `invoke()` is a thin aggregator over `stream()`, AbortController bridge has clean listener cleanup, capabilities match §4.6.8 verbatim, SDK network retries inherited, self-registration guarded against double-registration, no provider-level retry loop.
- `providers/types.ts`: Result flip faithful across `authenticate` / `invoke`, `stream` stays AsyncIterable, JSDoc calls out the no-throw contract.
- `mock-provider.ts`: matches the new Result signatures; throw-from-stream is the approved exception.
- `zod-to-json-schema.ts`: native Zod v4, Result-returning, `target: 'draft-07'` and `reused: 'inline'` correct.
- `index.ts`: public re-exports complete; auth/env/translate stay private per §4.6.10.

---

## Other follow-ups (out of sprint-4 scope)

- `_work/sprint-4.json` task_30 description says "throw" but the Result flip landed mid-sprint. Sprint JSON is stale prose; hook blocks editing it. Accepted drift.
- `packages/core/package.json:33` pins `@anthropic-ai/claude-agent-sdk: 0.2.112` as peer. BLOCK-1's env-merge behavior is tied to this exact SDK version; test should assert behavior under whatever SDK resolves.
- Tests do not land in sprint 4. Every flagged branch deserves a test — especially the smoke test that `ANTHROPIC_API_KEY` in `process.env` is NOT passed to the `claude` subprocess when `allowApiKey=false`.
