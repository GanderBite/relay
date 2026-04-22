# Billing safety

`relay doctor` · `relay run --api-key` · `ClaudeAuthError`

---

## The default guarantee

Relay defaults to subscription billing. A user with a Pro or Max Claude subscription
pays nothing to the Anthropic API for any race run, because Relay refuses to start
if it detects that `ANTHROPIC_API_KEY` is present in the environment without an
explicit opt-in.

The Claude CLI binary puts `ANTHROPIC_API_KEY` ahead of subscription credentials in
its own precedence chain. Without intervention a long-running race can silently bill
the API account before anyone notices. Relay blocks that path before any subprocess
is spawned.

The guard lives in `packages/core/src/providers/claude/auth.ts:79–86`:

```
if (hasApiKey && !allowApiKey && !hasCloudRouting) {
  return err(
    new ClaudeAuthError(API_KEY_REMEDIATION, {
      envObserved: ['ANTHROPIC_API_KEY'],
      billingSource: 'api-account',
    }),
  );
}
```

`ClaudeAuthError` maps to CLI exit code 3 (`packages/cli/src/exit-codes.ts:43`).
The run never starts; no tokens are spent.

---

## Auth precedence

`inspectClaudeAuth()` (`packages/core/src/providers/claude/auth.ts:61–152`)
evaluates the environment in a fixed order. A match short-circuits every branch
that follows.

**Case 1 — `ANTHROPIC_API_KEY` safety guard** (`auth.ts:79–86`)

Checked first, before any subprocess is launched. If `ANTHROPIC_API_KEY` is present
in the environment, no opt-in is active, and no cloud-routing variable is set,
`inspectClaudeAuth` returns `err(ClaudeAuthError)` with this message:

```
ANTHROPIC_API_KEY is set; relay defaults to subscription billing.
Unset it, or call runner.allowApiKey(), or set RELAY_ALLOW_API_KEY=1.
```

Cloud-routing variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_URL`) bypass this case because
those paths route tokens to cloud accounts, not the Anthropic API — the guard
does not apply (`auth.ts:69–73`).

**Case 2 — Cloud routing** (`auth.ts:96–119`)

If any cloud-routing variable is set, authentication succeeds with the matching
billing source:

- `CLAUDE_CODE_USE_BEDROCK=1` → `billingSource: 'bedrock'`
- `CLAUDE_CODE_USE_VERTEX=1` → `billingSource: 'vertex'`
- `CLAUDE_CODE_USE_FOUNDRY=1` or `ANTHROPIC_FOUNDRY_URL` set → `billingSource: 'foundry'`

**Case 3 — API-account opt-in** (`auth.ts:124–133`)

If `ANTHROPIC_API_KEY` is set and the user has explicitly opted in (see §Opt-in paths
below), authentication succeeds with `billingSource: 'api-account'`. A warning is
attached to the returned `AuthState`:

```
billing to API account, not subscription
```

The pre-run banner surfaces this warning so the billing destination is never implicit.

**Case 4 — OAuth token** (`auth.ts:136–142`)

If `CLAUDE_CODE_OAUTH_TOKEN` is set, authentication succeeds with
`billingSource: 'subscription'`. Recommended for CI: generate the token once via
`claude setup-token` and store it as a CI secret.

**Case 5 — Interactive subscription fallback** (`auth.ts:147–151`)

If none of the above apply, Relay assumes subscription credentials exist in
`~/.claude/credentials` and proceeds. The first real invocation surfaces an auth
failure loudly if the assumption is wrong. This is the typical path after
`claude login`.

---

## Env allowlist

`buildEnvAllowlist()` (`packages/core/src/providers/claude/env.ts:100–137`)
builds the environment object passed to every Claude subprocess invocation.
It does not forward `process.env` directly.

The function walks `process.env` once. For every key it either copies the real
value (allowlisted) or emits `undefined` (suppresses the inherited variable
via the SDK's merge semantics):

```
for (const [key, value] of Object.entries(process.env)) {
  const isExact = exact.has(key);
  const isPrefix = prefixes.some((p) => key.startsWith(p));

  if (isExact || isPrefix) {
    result[key] = value;   // forward
  } else {
    result[key] = undefined; // suppress
  }
}
```

**Always forwarded** — exact names (`env.ts:40–49`):

`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`

These are the minimum POSIX/system variables the `claude` binary needs for path
resolution, locale, timezone, and temp-file handling.

**Always forwarded** — `CLAUDE_` prefix (`env.ts:57`):

Every variable whose name begins with `CLAUDE_` passes through unconditionally.
This covers `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, and any future variables
the SDK adds in that family.

**Forwarded only on opt-in** — `ANTHROPIC_` prefix (`env.ts:64–67`):

When `allowApiKey: true`, every variable whose name begins with `ANTHROPIC_` is
forwarded. This covers `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_FOUNDRY_URL`, and future additions. When `allowApiKey` is absent or
false, the entire `ANTHROPIC_` family is suppressed — even if `ANTHROPIC_API_KEY`
is present in the parent process, it never reaches the subprocess.

**Caller extras merged last** (`env.ts:130–134`):

Per-runner or per-run env overrides supplied by the race author via the `extra`
option are merged on top after all allowlist logic runs. These always win and are
never suppressed.

The suppression design is intentional: the SDK merges a provided `env` object on
top of the inherited process env, so an allowlist of only wanted keys still leaves
all unlisted parent vars in place. Setting `undefined` is the only mechanism that
achieves true containment.

---

## Opt-in paths

Three mechanisms grant explicit consent to `ANTHROPIC_API_KEY` billing. All three
set the same `allowApiKey` flag that flows through `inspectClaudeAuth` and
`buildEnvAllowlist`.

**`runner.allowApiKey()`** (`packages/core/src/runner/runner.ts:185–188`)

Call on a `Runner` instance before `run()`. Chainable. The Runner substitutes the
registered `ClaudeProvider` with a fresh instance carrying `allowApiKey: true`
(`runner.ts:596–612`), so both `authenticate()` and the env allowlist see the flag
at construction time.

```ts
const runner = new Runner({ runDir });
runner.allowApiKey();
await runner.run(race, input, { raceDir, racePath });
```

**`RELAY_ALLOW_API_KEY=1`** (`packages/core/src/providers/claude/auth.ts:66–67`)

Set this environment variable before invoking any Relay process. It is checked
inside `inspectClaudeAuth` alongside the programmatic opt-in:

```
const envAllowsApiKey = isNonEmpty(env.RELAY_ALLOW_API_KEY);
const allowApiKey = opts.allowApiKey === true || envAllowsApiKey;
```

**`relay run --api-key`** (`packages/cli/src/commands/run.ts:125–229`)

The CLI flag sets `options.apiKey: true`, which is passed to `new ClaudeProvider`
at construction (`run.ts:125`) and also calls `runner.allowApiKey()` before the
run starts (`run.ts:227–229`).

In all three cases, when `ANTHROPIC_API_KEY` is active and an opt-in is confirmed,
`inspectClaudeAuth` returns `AuthState` with `billingSource: 'api-account'` and
attaches a warning surfaced in the pre-run banner and end-of-run cost row.

---

## Containment boundary

The env allowlist described above applies to **prompt runners only**. Other runner types
have different execution models and different containment guarantees.

**Prompt runners — contained**

`executePrompt` (`packages/core/src/runner/exec/prompt.ts`) invokes the provider's
`invoke()` method. `ClaudeProvider` builds the subprocess env via `buildEnvAllowlist`
before every call. `ANTHROPIC_API_KEY` never reaches the `claude` subprocess unless
the user opted in.

**Script runners — NOT contained**

`executeScript` (`packages/core/src/runner/exec/script.ts:44–48`) runs a
user-controlled shell command with the full parent process env:

```
// user-controlled shell; claude env allowlist does not apply.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(...),
);
const env: Record<string, string> = { ...baseEnv, ...(runner.env ?? {}) };
```

A script runner receives every variable present in `process.env`, including
`ANTHROPIC_API_KEY`. Race authors who run `claude` directly from a script runner
are responsible for their own billing safety.

**Branch runners — NOT contained**

`executeBranch` (`packages/core/src/runner/exec/branch.ts`) follows the same
execution path as script runners. Branch commands receive the full parent env.

**Parallel and terminal runners** do not spawn subprocesses directly — they delegate
to contained runners, which follow the rules above.

---

## Inspecting the state before a run

`relay doctor` (`packages/cli/src/commands/doctor.ts`) runs five checks and exits
before any race runner executes:

1. Node version (≥ 20.10.0)
2. `claude` binary reachable on PATH
3. Auth state — calls `ClaudeProvider({ allowApiKey: true }).authenticate()` to
   show which billing source would be active
4. Env — checks `ANTHROPIC_API_KEY` directly and renders the full remediation
   block if it is set (`doctor.ts:199–228`)
5. `.relay` directory writable

Exit codes: 0 (no blockers), 3 (only the API-key guard is blocking), 1 (other
blockers). Exit 3 matches the `ClaudeAuthError` code in
`packages/cli/src/exit-codes.ts:43` so CI scripts can distinguish billing
misconfigurations from all other failures.

---

## Cost labeling

`InvocationResponse.costUsd` (`packages/core/src/providers/types.ts:172–178`) is
an API-equivalent estimate, not a charge. For subscription-billed runs the comment
states:

```
For subscription-billed providers this reflects a compute-equivalent
estimate, not a charge; the Runner surfaces it as informational only.
```

The end-of-run banner labels this distinction explicitly. Billing mode is always
named; silence never implies safety.
