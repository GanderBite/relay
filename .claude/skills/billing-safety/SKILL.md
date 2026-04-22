---
name: billing-safety
description: Relay's `ANTHROPIC_API_KEY` safety contract — the §8.1 guard that prevents subscription users from silently routing tokens to a paid API account, the error hierarchy that surfaces auth/billing failures, the doctor command's blocking checks, and the env passthrough rules that contain the threat. Trigger this skill any time code touches `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the env allowlist, the doctor command, the auth inspector, the runner's authenticate phase, or any error formatting that mentions billing. The single most important non-functional requirement in the project.
---

# Billing Safety

Relay's most important non-functional requirement: **the library MUST NOT cause unintentional API billing for users with a Pro/Max subscription.** Every code path that could leak tokens to the paid API surface goes through the contract on this page.

## The threat (tech spec §8.1.1)

A user has a subscription. They install Relay and run a race. Several environments can silently route their tokens to the API and bill them:

- `ANTHROPIC_API_KEY` set in their shell rc (a leftover from earlier API experimentation).
- A parent process exported `ANTHROPIC_API_KEY` for some other tool.
- A CI runner has `ANTHROPIC_API_KEY` injected by the platform.

The Claude Agent SDK (and the underlying `claude` binary) puts `ANTHROPIC_API_KEY` AHEAD of subscription credentials in its auth precedence. Without intervention, a long-running flow can silently rack up tens or hundreds of dollars on the API account before the user notices ([Claude Code #37686](https://github.com/anthropics/claude-code/issues/37686)).

## The contract (tech spec §8.1.2)

The provider enforces this on every invocation:

```
1. Inspect process.env BEFORE calling the SDK.

2. If ANTHROPIC_API_KEY is set
   AND opts.allowApiKey !== true
   AND process.env.RELAY_ALLOW_API_KEY !== '1':
     → throw ClaudeAuthError with the §8.1 remediation message
     → DO NOT call the SDK

3. If the user explicitly opted in (allowApiKey OR env var):
     → proceed
     → emit a single warning per run: "ANTHROPIC_API_KEY active — billing
       to API account, not subscription"

4. The `relay doctor` command makes this state inspectable WITHOUT running a flow.

5. The pre-run banner displays the active billing mode unconditionally:
   - "subscription (max)"
   - "subscription (pro)"
   - "API account"
   - "bedrock" / "vertex" / "foundry"
```

## Where this lives in code

| File | Role |
|---|---|
| `packages/core/src/providers/claude/auth.ts` | `inspectClaudeAuth()` — owns the safety check |
| `packages/core/src/providers/claude/env.ts` | `buildEnvAllowlist()` — drops env vars by default |
| `packages/core/src/providers/claude/provider.ts` | `ClaudeProvider.authenticate()` — calls inspector |
| `packages/core/src/runner/runner.ts` | Calls `provider.authenticate()` once per provider per run |
| `packages/cli/src/commands/doctor.ts` | Surfaces the state to the user before they spend tokens |
| `packages/cli/src/exit-codes.ts` | Maps `ClaudeAuthError` → exit code 3 |

## The remediation message

When `ClaudeAuthError` fires for the API-key conflict:

```
ANTHROPIC_API_KEY is set; relay defaults to subscription billing.
Unset it, or call runner.allowApiKey(), or set RELAY_ALLOW_API_KEY=1.
```

The CLI's `formatError` (sprint 6 task_46) renders this in the §6.2 doctor block format:

```
✕ env  ANTHROPIC_API_KEY is set in your environment
       running a race now would bill your API account,
       not your Max subscription.

       fix:      unset ANTHROPIC_API_KEY
       permanent: remove the line from ~/.zshrc
       override: relay run --api-key (opts into API billing)
```

## Env allowlist (tech spec §4.6.11 + §8.1)

`buildEnvAllowlist({ allowApiKey, extra }): Record<string, string>` builds an explicit env object — never inherits raw `process.env`.

Always include:
- `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`
- All vars with prefix `CLAUDE_` (covers `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, etc.)

Conditionally include (only when `allowApiKey: true`):
- All vars with prefix `ANTHROPIC_` (covers `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, etc.)

Drop everything else. Merge `extra` (caller-provided per-step env) on top.

This contains the safety surface — even if `ANTHROPIC_API_KEY` is in `process.env`, it never reaches the SDK unless the user opted in.

## Cost labeling (tech spec §4.7)

Cost reported by Claude is an **API-equivalent estimate**. When the user runs against their subscription, they are not billed this dollar amount — it counts toward subscription quota.

The CLI's end-of-run banner labels this honestly:

- Subscription billing: `cost  $0.38  (estimated api equivalent; billed to subscription)`
- API billing: `cost  $0.38  (billed to your API account)`
- Bedrock/Vertex/Foundry: `cost  $0.38  (billed to your <cloud> account)`

This avoids the misunderstanding called out in [Claude Code #20976](https://github.com/anthropics/claude-code/issues/20976).

## Test coverage requirements

Every branch of `inspectClaudeAuth` MUST have a test:

- ANTHROPIC_API_KEY set, no opt-in → throws ClaudeAuthError.
- ANTHROPIC_API_KEY set, `allowApiKey: true` → returns AuthState with warning.
- ANTHROPIC_API_KEY set, `RELAY_ALLOW_API_KEY=1` env → returns AuthState with warning.
- CLAUDE_CODE_OAUTH_TOKEN set → returns billingSource: 'subscription'.
- CLAUDE_CODE_USE_BEDROCK=1 → returns billingSource: 'bedrock'.
- CLAUDE_CODE_USE_VERTEX=1 → returns billingSource: 'vertex'.
- CLAUDE_CODE_USE_FOUNDRY=1 → returns billingSource: 'foundry'.
- No claude binary → throws ClaudeAuthError with install instructions.

`buildEnvAllowlist` tests:

- ANTHROPIC_API_KEY in process.env, allowApiKey=false → omitted from output.
- ANTHROPIC_API_KEY in process.env, allowApiKey=true → included.
- Random `MY_SECRET=...` in process.env → omitted regardless.
- `CLAUDE_CODE_USE_BEDROCK=1` → included.
- `extra: { FOO: 'bar' }` → merged on top.

See `references/auth-threat-model.md` for the full attack surface.

## Hard rules for any code that might bypass this

1. **Don't call `query()` from the SDK without first calling `inspectClaudeAuth`.** Every call path goes through the provider's `invoke`, which goes through `authenticate`, which goes through `inspectClaudeAuth`.
2. **Don't pass `process.env` to anything that spawns a subprocess.** Always use the allowlist builder.
3. **Don't catch `ClaudeAuthError` and continue.** Always propagate. The CLI maps it to exit 3.
4. **Don't make the `bill` row conditional in the pre-run banner.** Every banner names the billing source. Silence implies safety; we don't get to imply.
5. **Don't add a "shortcut" to skip the auth check.** There is no shortcut. If a test needs to skip auth, use MockProvider.

## CI usage

For CI, generate `CLAUDE_CODE_OAUTH_TOKEN` once via `claude setup-token` and store as a CI secret. This token is subscription-billed.

**No `ANTHROPIC_API_KEY` should ever be set in a Relay CI environment.**

`relay doctor` should be the first step in any CI job that runs Relay — the build fails loudly at setup if the env is misconfigured.
