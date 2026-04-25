# Billing safety

`relay doctor` · `ClaudeAuthError`

---

## The guarantee

Relay runs on your Claude subscription (Pro or Max). No API key is required or
accepted. The only supported provider is `ClaudeCliProvider`, which spawns the
`claude` binary using your subscription credentials.

`ClaudeAuthError` (exit code 3) fires before any subprocess is launched if
subscription credentials are not found. No tokens are spent in that case.

---

## Auth precedence

`inspectClaudeAuth()` (`packages/core/src/providers/claude-cli/auth.ts`)
evaluates the environment in a fixed order:

1. **Cloud routing** — `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1`,
   `CLAUDE_CODE_USE_FOUNDRY=1`, or `ANTHROPIC_FOUNDRY_URL` set → authentication
   succeeds with the matching cloud billing source.

2. **OAuth token** — `CLAUDE_CODE_OAUTH_TOKEN` set → `billingSource: 'subscription'`.
   Recommended for CI: generate the token once via `claude /login` and store it as
   a CI secret.

3. **Interactive credentials** — `~/.claude/.credentials.json` exists →
   `billingSource: 'subscription'`. The typical path after `claude /login`.

4. **None found** → `err(ClaudeAuthError)`. Run `claude /login` to authenticate.

---

## Env allowlist

`buildEnvAllowlist()` (`packages/core/src/providers/claude-cli/env.ts`) builds the
env object passed to every `claude -p` subprocess. It does not forward `process.env`
directly.

The function walks `process.env` and either copies a value (allowlisted) or emits
`undefined` (suppresses the inherited variable):

**Always forwarded** — exact names:
`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`

**Always forwarded** — prefix `CLAUDE_`:
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`CLAUDE_CODE_USE_FOUNDRY`, and any future `CLAUDE_*` vars.

**Always forwarded** — cloud-routing exact keys:
`ANTHROPIC_FOUNDRY_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`CLAUDE_CODE_USE_FOUNDRY`.

**Everything else** — suppressed to `undefined`. Unlisted vars never reach the
subprocess.

**Caller extras merged last**: Per-step env overrides in `step.script({ env: {...} })`
are merged on top after allowlist logic runs. These always win.

**Script and branch steps** — NOT contained. These steps run user-controlled shell
commands with the full parent process env. Flow authors are responsible for their own
credential hygiene inside script steps.

---

## Inspecting auth before a run

`relay doctor` runs five checks before any flow step executes:

1. Node version (≥ 20.10.0)
2. `claude` binary reachable on PATH
3. Auth state — calls `ClaudeCliProvider.authenticate()` to show which billing
   source would be active
4. Subscription credentials present
5. `.relay` directory writable

Exit codes: 0 (no blockers), 3 (auth check blocking), 1 (other blockers).

---

## Cost labeling

`InvocationResponse.costUsd` is an API-equivalent compute estimate, not a charge.
For subscription-billed runs it is informational only. The end-of-run banner labels
this distinction explicitly.
