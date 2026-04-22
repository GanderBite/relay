# Sprint 13 Acceptance Report

task_127 — live acceptance: per-provider auth + three-tier selection + TOS-leak guard
date: 2026-04-22
machine: darwin 25.3.0 (macOS Sequoia)

---

## Summary table

| # | Scenario | Status | Exit code | Notes |
|---|---|---|---|---|
| 1 | Fresh init — CLI PATH (live subscription) | SKIPPED | — | No `~/.claude/.credentials.json`; code path traced below |
| 2a | Fresh init — SDK PATH, no API key | PASS | 3 | Remediation printed, settings.json not written |
| 2b | Fresh init — SDK PATH, `ANTHROPIC_API_KEY=sk-test-fake` | PASS | 0 | settings.json written with `claude-agent-sdk` |
| 2c | Fresh init — SDK PATH, OAuth token set (TOS-leak) | PASS | 3 | Remediation printed, settings.json not written |
| 3 | TOS-leak guard (`--provider claude-agent-sdk` + OAuth token) | PARTIAL | 3 | Correct error type (`SubscriptionTosLeakError`, `E_TOS_LEAK_BLOCKED`) and exit code; formatted message is misleading (see FINDINGS) |
| 4 | Global-settings path — subscription run | SKIPPED | — | Requires live subscription; code path traced below |
| 5 | Flag override — `--provider claude-agent-sdk` + `sk-test-fake` | PASS | 1 | SDK used, downstream API rejection as expected |
| 6 | Flow-level override wins over global | PASS | 1 | Flow `settings.json` picked `claude-agent-sdk`; downstream API rejection as expected |
| 7 | No provider configured | FAIL | 3 | `NoProviderConfiguredError` never surfaces; `run.ts` blocks first at step 3 with spurious ClaudeAuthError (see FINDINGS) |
| 8 | Doctor — multiple configurations | PASS | various | All provider/resolver/auth rows correct; exit codes correct |
| 9 | Abort — kill live run, no orphan processes | SKIPPED | — | Requires live subscription to spawn a real subprocess |

---

## Pre-conditions and environment

```
OS            macOS darwin 25.3.0
Node          25.8.0 (≥ 20.10.0)
claude binary /Applications/cmux.app/Contents/Resources/bin/claude  v2.1.117
~/.claude/.credentials.json   absent (subscription login not completed on this machine)
ANTHROPIC_API_KEY             not set in shell at start of session
CLAUDE_CODE_OAUTH_TOKEN       not set in shell at start of session
~/.relay/settings.json        {"provider":"claude-cli"}  (pre-existing, backed up and restored)
```

### Build fix required before scenarios

The CLI's tsup build had a critical defect: the dispatcher (`dispatcher.ts`) uses a template-literal dynamic `import(\`./commands/${name}.js\`)`. tsup's bundler transforms this into an empty `__glob({})` map, causing every command to fail with `Module not found in bundle: ./commands/doctor.js`. The fix was to change `tsup.config.ts` to use `bundle: false` and enumerate all CLI source files as entries, so Node.js resolves the dynamic import against the transpiled `dist/commands/*.js` files at runtime. After this fix, all scenarios ran correctly.

---

## Scenario 1 — Fresh init, CLI PATH (SKIPPED)

**Requires:** Active Claude Pro/Max subscription, completed `claude /login` (produces `~/.claude/.credentials.json`).

**Current machine state:** `~/.claude/.credentials.json` is absent. The `claude` binary is installed at version 2.1.117.

**Code path trace (from `packages/core/src/providers/claude/auth.ts` + `packages/cli/src/commands/init.ts`):**

1. `relay init` (interactive) shows the two-option provider menu.
2. User selects `1` (claude-cli). `initCommand` calls `handleClaudeCliAuth`.
3. `handleClaudeCliAuth` constructs `new ClaudeCliProvider()` and calls `provider.authenticate()`.
4. `inspectClaudeAuth({ providerKind: 'claude-cli' })` is invoked.
5. `hasOauth` is false → first branch skipped.
6. `existsSync(join(homedir(), '.claude', '.credentials.json'))` is checked.
7. On a logged-in machine this returns `true` → `ensureClaudeBinary()` is called → `claude --version` exits 0 → `ok({ billingSource: 'subscription', detail: 'subscription (interactive credentials)' })`.
8. `initCommand` writes `{"provider":"claude-cli"}` to `~/.relay/settings.json` via `atomicWriteJson`.
9. Prints `✓ wrote ~/.relay/settings.json` and `→ next: relay doctor`.

**The offer of `claude /login`** is exercised via the non-subscribed code path (tested separately):

```
Command:
  echo "n" | node packages/cli/bin/relay.js init --provider claude-cli

Output:
  ●─▶●─▶●─▶●  relay init

  claude-cli requires subscription auth. Run `claude /login`, or run `relay init` and choose claude-agent-sdk.

  run `claude /login` now? [Y/n]: n
  → run `claude /login` when ready, then re-run `relay init`

Exit: 1
settings.json: NOT WRITTEN
```

When the user answers `Y`, `spawnAttached('claude', ['/login'])` is called with `stdio: 'inherit'`. After a successful `claude /login` (exit 0), `provider.authenticate()` is re-probed. If `~/.claude/.credentials.json` now exists, `ok(subscription)` is returned and settings are written.

---

## Scenario 2a — Fresh init, SDK PATH, no API key (PASS)

```
Commands run:
  rm -f ~/.relay/settings.json
  unset ANTHROPIC_API_KEY
  unset CLAUDE_CODE_OAUTH_TOKEN
  node packages/cli/bin/relay.js init --provider claude-agent-sdk

Output (stderr):
  ●─▶●─▶●─▶●  relay init

  claude-agent-sdk requires ANTHROPIC_API_KEY. Set it, or run `relay init` and choose claude-cli.

Exit: 3
settings.json: NOT WRITTEN
```

**Verdict: PASS.** `ClaudeAgentSdkProvider.authenticate()` returns `err(ClaudeAuthError)` with code `relay_CLAUDE_AUTH`. `handleClaudeAgentSdkAuth` prints the remediation message and calls `process.exit(3)`. Settings file is not written.

---

## Scenario 2b — Fresh init, SDK PATH, `ANTHROPIC_API_KEY=sk-test-fake` (PASS)

```
Commands run:
  rm -f ~/.relay/settings.json
  export ANTHROPIC_API_KEY="sk-test-fake"
  unset CLAUDE_CODE_OAUTH_TOKEN
  node packages/cli/bin/relay.js init --provider claude-agent-sdk

Output (stdout):
  ●─▶●─▶●─▶●  relay init

  ✓ wrote ~/.relay/settings.json
  → next: relay doctor

Exit: 0
settings.json: {"provider":"claude-agent-sdk"}
```

**Verdict: PASS.** `inspectClaudeAuth` detected `hasApiKey=true` for `claude-agent-sdk` → `ok({ billingSource: 'api-account' })`. Settings written correctly via `atomicWriteJson`.

---

## Scenario 2c — Fresh init, SDK PATH, OAuth token present (TOS-leak in init) (PASS)

```
Commands run:
  rm -f ~/.relay/settings.json
  unset ANTHROPIC_API_KEY
  export CLAUDE_CODE_OAUTH_TOKEN="oauth-dummy-test"
  node packages/cli/bin/relay.js init --provider claude-agent-sdk

Output (stderr):
  ●─▶●─▶●─▶●  relay init

  subscription tokens may not be used with claude-agent-sdk. Set ANTHROPIC_API_KEY for API billing, or switch to claude-cli.

Exit: 3
settings.json: NOT WRITTEN
```

**Verdict: PASS.** `SubscriptionTosLeakError` (`E_TOS_LEAK_BLOCKED`) is returned by `inspectClaudeAuth`. `handleClaudeAgentSdkAuth` detects `authErr instanceof SubscriptionTosLeakError` → prints the TOS-leak remediation message and calls `process.exit(3)`. Settings file is not written. The TOS-leak message is verbatim from `auth.ts`.

---

## Scenario 3 — TOS-leak guard, `relay run --provider claude-agent-sdk` (PARTIAL)

```
Commands run:
  echo '{"provider":"claude-cli"}' > ~/.relay/settings.json
  unset ANTHROPIC_API_KEY
  export CLAUDE_CODE_OAUTH_TOKEN="oauth-dummy-test"
  node packages/cli/bin/relay.js run examples/hello-world --provider claude-agent-sdk name=World

Output (stderr):
  ✕ Refusing to run: ANTHROPIC_API_KEY would override your subscription

    Relay detected ANTHROPIC_API_KEY in your environment. Running now would
    bill your API account instead of your Max subscription — a surprise we
    prevent by default.

    → unset ANTHROPIC_API_KEY                 use subscription (recommended)
    → relay run codebase-discovery . --api-key  explicitly use API billing
    → relay doctor                             full environment check

Exit: 3
claude -p processes after exit: 0 (verified via ps aux)
```

**Core library verification (direct):**
```
node -e "import ClaudeAgentSdkProvider; auth with CLAUDE_CODE_OAUTH_TOKEN set"
→ error.name: SubscriptionTosLeakError
→ error.code: E_TOS_LEAK_BLOCKED
→ error instanceof SubscriptionTosLeakError: true
```

**What passed:**
- Exit code is 3 (auth error).
- `SubscriptionTosLeakError` with code `E_TOS_LEAK_BLOCKED` is correctly thrown by the core library.
- No `claude -p` subprocess was spawned (verified via `ps aux | grep "claude -p"`).
- The block occurs before any subprocess is launched.

**Finding F-1 (non-blocking, format bug):** The error message displayed to the user is wrong. `exit-codes.ts` `formatError` falls through to the generic `ClaudeAuthError` branch for `SubscriptionTosLeakError` and shows "Refusing to run: ANTHROPIC_API_KEY would override your subscription" — a message about a different problem. The `init.ts` command formats this correctly (it uses `authErr.message` directly); only `run.ts` suffers from this. The `SubscriptionTosLeakError` is not given its own formatting shape in `formatError`. See FINDINGS section.

**Verdict: PARTIAL** — error type and exit code are correct; user-visible message is wrong.

---

## Scenario 4 — Global-settings path, subscription run (SKIPPED)

**Requires:** Active Claude Pro/Max subscription and `~/.claude/.credentials.json`.

**Code path trace (from `run.ts` + `runner.ts` + `auth.ts`):**

With `{"provider":"claude-cli"}` in global settings and no `ANTHROPIC_API_KEY`:

1. `run.ts` step 3 calls `new ClaudeAgentSdkProvider().authenticate()`. With no API key and no OAuth token, this returns `err(ClaudeAuthError)` and the run aborts early. **This is a separate bug** — see Finding F-2.

For the theoretical happy-path (once F-2 is fixed or subscription credentials are present):

1. Runner loads flow, resolves provider via `resolveProvider({ globalSettings: {provider:'claude-cli'}, ... })` → picks `ClaudeCliProvider`.
2. `ClaudeCliProvider.authenticate()` returns `ok({ billingSource: 'subscription' })`.
3. `buildEnvAllowlist({ providerKind: 'claude-cli' })` is called. This builder explicitly omits `ANTHROPIC_API_KEY` even if it is in `process.env`. The allowlist only includes `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`, and all `CLAUDE_*` vars.
4. `runClaudeProcess` is called with the sanitized env. No `ANTHROPIC_API_KEY` reaches the subprocess.

**ANTHROPIC_API_KEY subprocess isolation (code trace):**
`packages/core/src/providers/claude/env.ts` `buildEnvAllowlist` with `providerKind: 'claude-cli'` — the `ANTHROPIC_` prefix block is only included when `allowApiKey: true`. With the CLI provider this is never set, so `ANTHROPIC_API_KEY` is absent from the subprocess env by construction. macOS `lsof -p` / `ps` verification is not possible without a live run.

---

## Scenario 5 — Flag override `--provider claude-agent-sdk` (PASS)

```
Commands run:
  echo '{"provider":"claude-cli"}' > ~/.relay/settings.json
  export ANTHROPIC_API_KEY="sk-test-fake"
  unset CLAUDE_CODE_OAUTH_TOKEN
  node packages/cli/bin/relay.js run examples/hello-world --provider claude-agent-sdk name=World

Output (stdout, excerpt):
  ●─▶●─▶●─▶●  relay

  flow    hello-world v0.1.0
  input   name=World
  run     28fd4e  ·  2026-04-22 15:17Z
  bill    api account  ·  billing applies

  [stderr/structured log excerpt]
  event="prompt.start" provider="claude-agent-sdk"
  event="prompt.failed" message="Claude Code returned an error result: Invalid API key · Fix external API key"

Exit: 1 (downstream API rejection — expected with fake key)
```

**Verdict: PASS.** The `--provider claude-agent-sdk` flag was picked up by `runner.ts`'s `resolveProvider({ flagProvider: 'claude-agent-sdk', ... })`. The run proceeded via the SDK provider. The structured log confirms `provider="claude-agent-sdk"`. The downstream rejection by Anthropic's API with an invalid key is the expected outcome — no credentials were available for a real run. The start banner correctly shows `bill: api account`.

---

## Scenario 6 — Flow-level settings override (PASS)

```
Commands run:
  echo '{"provider":"claude-cli"}' > ~/.relay/settings.json
  echo '{"provider":"claude-agent-sdk"}' > examples/hello-world/settings.json
  export ANTHROPIC_API_KEY="sk-test-fake"
  unset CLAUDE_CODE_OAUTH_TOKEN
  node packages/cli/bin/relay.js run examples/hello-world name=World

Output (stdout, excerpt):
  ●─▶●─▶●─▶●  relay

  flow    hello-world v0.1.0
  input   name=World
  bill    api account  ·  billing applies

  event="prompt.start" provider="claude-agent-sdk"
  event="prompt.failed" message="Claude Code returned an error result: Invalid API key · Fix external API key"

Exit: 1 (downstream API rejection — expected with fake key)
```

**Cleanup:** `examples/hello-world/settings.json` removed after test.

**Verdict: PASS.** Flow-level `settings.json` with `{"provider":"claude-agent-sdk"}` overrode the global `{"provider":"claude-cli"}`. The resolver precedence (`flagProvider → flowSettings → globalSettings`) works correctly. The structured log confirms `provider="claude-agent-sdk"`.

---

## Scenario 7 — No provider configured (FAIL)

```
Commands run:
  rm -f ~/.relay/settings.json
  unset ANTHROPIC_API_KEY
  unset CLAUDE_CODE_OAUTH_TOKEN
  node packages/cli/bin/relay.js run examples/hello-world name=World

Output (stderr):
  ✕ Refusing to run: ANTHROPIC_API_KEY would override your subscription

    Relay detected ANTHROPIC_API_KEY in your environment. Running now would
    bill your API account instead of your Max subscription — a surprise we
    prevent by default.

    → unset ANTHROPIC_API_KEY                 use subscription (recommended)
    → relay run codebase-discovery . --api-key  explicitly use API billing
    → relay doctor                             full environment check

Exit: 3
```

**Expected:** `NoProviderConfiguredError` with verbatim remediation `no provider configured. run \`relay init\` to pick one, or pass \`--provider claude-cli\` or \`--provider claude-agent-sdk\`.`; exit code 6.

**Actual:** Exit 3 with misleading `ANTHROPIC_API_KEY` message.

**Root cause (Finding F-2):** `run.ts` step 3 constructs `new ClaudeAgentSdkProvider()` and calls `.authenticate()` unconditionally, before any provider is resolved from settings. With no API key and no OAuth token, `inspectAgentSdk` returns `err(ClaudeAuthError)` for "no API key". `formatError` maps this to the ANTHROPIC_API_KEY-conflict shape (wrong message), and `process.exit(3)` is called. The runner never reaches `resolveProvider`, so `NoProviderConfiguredError` is never thrown.

**Verdict: FAIL.** The correct error type is never shown to the user.

---

## Scenario 8 — Doctor, multiple configurations (PASS)

### 8a: global=`claude-agent-sdk`, `ANTHROPIC_API_KEY=sk-test-fake`

```
Exit: 3 (ANTHROPIC_API_KEY is the sole blocker)

providers block:
  claude-cli          · subscription-safe
  claude-agent-sdk    · API-account billing

auth block:
  ✕ claude-cli          · claude-cli requires subscription auth. ...
  ✓ claude-agent-sdk    · API-account ready

resolver:
  → resolves to: claude-agent-sdk (global-settings)

summary: 1 blocker before you can run.
```

### 8b: global=`claude-agent-sdk`, no credentials

```
Exit: 0 (resolver resolves, auth probe failures are informational)

auth block:
  ✕ claude-cli          · requires subscription auth
  ✕ claude-agent-sdk    · requires ANTHROPIC_API_KEY

resolver:
  → resolves to: claude-agent-sdk (global-settings)

summary: ready to run.
```

Note: Doctor reports "ready to run" even when both auth probes fail. This is by design — the auth block is informational; only the resolver determines readiness.

### 8c: no settings file

```
Exit: 1 (resolver failed — no provider configured)

auth block:
  ✕ claude-cli          · requires subscription auth
  ✕ claude-agent-sdk    · requires ANTHROPIC_API_KEY

resolver:
  no provider configured. run `relay init` to pick one, or pass `--provider claude-cli` or `--provider claude-agent-sdk`.

summary: 1 blocker before you can run.
```

### 8d: `CLAUDE_CODE_OAUTH_TOKEN=oauth-dummy`, no settings

```
Exit: 1 (resolver failed — no provider configured)

auth block:
  ✓ claude-cli          · subscription ready
  ✕ claude-agent-sdk    · subscription tokens may not be used with claude-agent-sdk. ...

resolver:
  no provider configured. run `relay init` to pick one, ...

summary: 1 blocker before you can run.
```

### 8e: global=`claude-cli`, no credentials, no env vars

```
Exit: 0 (resolver resolves, auth failures are informational)

auth block:
  ✕ claude-cli          · requires subscription auth
  ✕ claude-agent-sdk    · requires ANTHROPIC_API_KEY

resolver:
  → resolves to: claude-cli (global-settings)

summary: ready to run.
```

**Verdict: PASS.** All provider/auth/resolver rows are correct. Exit codes follow the spec: 3 for sole ANTHROPIC_API_KEY blocker, 1 for other blockers, 0 for no blockers.

---

## Scenario 9 — Abort, no orphan processes (SKIPPED)

**Requires:** Active subscription to spawn a live `claude -p` subprocess.

**Code path verified by inspection (`packages/core/src/providers/claude-cli/process.ts`):**

The `runClaudeProcess` async generator registers `abortSignal.addEventListener('abort', onAbort)`. On abort:
1. `child.kill('SIGTERM')` is sent immediately.
2. A `setTimeout` schedules `child.kill('SIGKILL')` after `SIGKILL_GRACE_MS` (2000 ms).
3. The `close` event clears the `SIGKILL` timer via `clearTimeout`.
4. `abortSignal.removeEventListener('abort', onAbort)` is called to prevent re-entry.

The `process.ts` module's terminal value path (`exitCode: null, signal: 'SIGTERM'`) feeds into `classifyExit` which returns an `AbortedError` rather than a `StepFailureError`, preventing the runner from emitting misleading failure state.

No orphan processes are expected because both `SIGTERM` and `SIGKILL` paths target the specific `child.pid`.

---

## Findings

### F-1 — `formatError` shows wrong message for `SubscriptionTosLeakError` in `run.ts` (non-blocking)

**Location:** `packages/cli/src/exit-codes.ts`, `formatError`, ClaudeAuthError branch.

**Problem:** `SubscriptionTosLeakError` extends `ClaudeAuthError`. When `run.ts` calls `new ClaudeAgentSdkProvider().authenticate()` and gets back a `SubscriptionTosLeakError`, `formatError` falls to the catch-all `ClaudeAuthError` shape and prints "Refusing to run: ANTHROPIC_API_KEY would override your subscription" — a message about a completely different problem. The correct message is "subscription tokens may not be used with claude-agent-sdk...".

**Fix:** Add an `instanceof SubscriptionTosLeakError` guard before the generic `ClaudeAuthError` guard in `formatError`.

### F-2 — `run.ts` always calls `ClaudeAgentSdkProvider().authenticate()` before provider resolution (blocking)

**Location:** `packages/cli/src/commands/run.ts`, step 3 (lines 130–136).

**Problem:** `run.ts` constructs `new ClaudeAgentSdkProvider()` unconditionally to read the billing state for the start banner. This runs before `runner.run()` calls `resolveProvider`. With no credentials and no provider configured:
- `inspectAgentSdk` returns `err(ClaudeAuthError("claude-agent-sdk requires ANTHROPIC_API_KEY..."))`.
- `run.ts` formats and prints this error, calls `process.exit(3)`.
- `NoProviderConfiguredError` is never reached.

This means:
- Scenario 7's expected `NoProviderConfiguredError` never surfaces.
- A user who forgets to set `ANTHROPIC_API_KEY` but has `claude-cli` in their global settings gets a misleading error about the SDK provider.

**Fix:** `run.ts` should resolve the provider from settings first (or at least check settings before running auth). The billing banner should use the resolved provider's auth result, not a hardcoded SDK auth.

### F-3 — `tsup.config.ts` produces non-functional CLI build (blocking at build time, fixed for this report)

**Location:** `packages/cli/tsup.config.ts`.

**Problem:** The config only listed `src/cli.ts` as an entry and used `bundle: true` (default). tsup transforms the template-literal dynamic `import(\`./commands/${name}.js\`)` in `dispatcher.ts` into an empty `__glob({})` map. All commands fail at runtime with `Module not found in bundle: ./commands/doctor.js`.

**Fix applied:** Changed to `bundle: false` with all CLI source files as explicit entries. tsup transpiles each file individually; Node.js resolves dynamic imports natively against `dist/commands/*.js`.

---

## Unit test results

All tests pass after the build fix:

```
@relay/core:   41 test files, 329 tests passed
@relay/cli:    2 test files passed, 1 skipped (no live claude binary tests)
```

---

## Final verdict

**SPRINT CLOSE: BLOCKED**

Blocking finding: **F-2** — `run.ts` unconditionally runs `ClaudeAgentSdkProvider` auth before resolving the configured provider. This causes scenario 7 to fail: `NoProviderConfiguredError` is never shown to users who have no settings file and no credentials. This is a correctness bug in the `run` command's auth-before-resolve order.

Non-blocking findings: F-1 (wrong message for `SubscriptionTosLeakError`), F-3 (tsup build config — fixed in this report).

**Runnable scenarios that pass:** 2a, 2b, 2c, 5, 6, 8 (all doctor sub-cases).
**Scenario that fails:** 7 (NoProviderConfiguredError not surfaced).
**Scenarios skipped (require live subscription):** 1, 4, 9.

The TOS-leak guard (scenario 3) is **functionally correct at the library level** — `SubscriptionTosLeakError` with `E_TOS_LEAK_BLOCKED` is thrown, no subprocess is spawned, exit is non-zero. However the CLI message shown to the user is wrong (F-1). Whether this constitutes a blocker depends on severity assessment by the orchestrator.
