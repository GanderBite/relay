# Auth Threat Model — Detailed

## Threat 1: ANTHROPIC_API_KEY in shell rc

**Scenario.** User experimented with the API months ago, exported `ANTHROPIC_API_KEY` in `~/.zshrc`, forgot. Today they buy Max subscription, install Relay, run a 30-minute flow. The SDK's auth precedence picks `ANTHROPIC_API_KEY` first. The user's API account is billed; their Max quota is untouched. They wake up to a $47 charge.

**Mitigation.** `inspectClaudeAuth` checks `process.env.ANTHROPIC_API_KEY` BEFORE calling the SDK. Throws `ClaudeAuthError` with explicit remediation if found and not opted in. `relay doctor` catches it pre-run.

**Test:**
```ts
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
vi.stubEnv('RELAY_ALLOW_API_KEY', '');
await expect(inspectClaudeAuth({})).rejects.toThrow(ClaudeAuthError);
```

## Threat 2: Parent process leaked env

**Scenario.** User runs Relay from inside another tool (a bash script, a Makefile, a CI job) that exported `ANTHROPIC_API_KEY` for its own purposes. The variable is in Relay's `process.env` even though it's not in the user's shell rc.

**Mitigation.** Same check — `inspectClaudeAuth` doesn't care where the var came from, only whether it's present and opted-in.

**Note.** This is also why the env allowlist drops `ANTHROPIC_API_KEY` by default — even if the safety check is somehow bypassed (it shouldn't be), the SDK doesn't see the var.

## Threat 3: CI platform injection

**Scenario.** GitHub Actions, GitLab CI, etc. inject `ANTHROPIC_API_KEY` automatically when the org has it set as a secret. Even without explicit `env:` declarations in the workflow file.

**Mitigation.** `relay doctor` as first CI step fails the build with exit 3. CI users are instructed (via README + product spec §8.1.3) to use `CLAUDE_CODE_OAUTH_TOKEN` instead.

**Test in CI:**
```yaml
- name: relay doctor (verify subscription billing)
  run: relay doctor
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    # ANTHROPIC_API_KEY explicitly NOT set
```

## Threat 4: Forgotten opt-in

**Scenario.** User wanted to test against the API once, set `RELAY_ALLOW_API_KEY=1` for that run, forgot to unset. Subsequent flows silently use API billing.

**Mitigation.** When the opt-in is active AND `ANTHROPIC_API_KEY` is set, the AuthState includes a warning, and the pre-run banner shows `bill  API account` in YELLOW (not green). The user sees it on every run.

The override is also designed to NOT persist — `RELAY_ALLOW_API_KEY=1 relay run ...` is one-shot. It's only durable if the user puts it in their shell rc, which is their explicit choice.

## Threat 5: SDK update changes auth precedence

**Scenario.** A future version of `@anthropic-ai/claude-agent-sdk` changes how it picks credentials, or starts caching them in a way Relay doesn't expect.

**Mitigation.** Relay's safety check is at the env level — it doesn't depend on SDK behavior. Even if the SDK changed, the env is filtered before the SDK runs. The check itself is only on the env state Relay can see.

The deeper mitigation: Relay's env allowlist is the actual contract. Even if `inspectClaudeAuth` had a bug, the allowlist would still drop `ANTHROPIC_API_KEY` from the env passed to the SDK.

## Threat 6: Cost confusion

**Scenario.** User runs a flow on Max subscription. Banner says `cost: $0.38`. User thinks they were charged $0.38 above their subscription fee. Actually they were charged $0 (subscription quota covers it). User loses trust ("Relay overcharged me!").

**Mitigation.** Banner labels cost honestly:

- Subscription billing: `cost  $0.38  (estimated api equivalent; billed to subscription)`
- API billing: `cost  $0.38  (billed to your API account)`

Per [Claude Code #20976](https://github.com/anthropics/claude-code/issues/20976) — the issue this label specifically addresses.

## Threat 7: Hidden cost in long flows

**Scenario.** Multi-hour flow runs overnight on opted-in API billing. User wakes up to a $200 bill they didn't anticipate.

**Mitigation.** The CLI's progress display shows live `spent  $X.XX` on every redraw. The pre-run banner shows the estimated total. If the live spent exceeds the estimated max, the runner does NOT abort (steps may legitimately exceed estimates), but the banner background turns yellow.

For v1 the per-step `maxBudgetUsd` cap (passed to the SDK) is honored when the provider's capability supports it (`ClaudeProvider.capabilities.budgetCap === true`).

## Threat 8: ANTHROPIC_API_KEY in a flow's env override

**Scenario.** A flow's `step.script` has `env: { ANTHROPIC_API_KEY: '...' }`. This bypasses the runner's auth guard because it's downstream of the check.

**Mitigation.** The auth guard is for the prompt-step path (Claude SDK calls). Script steps are user-controlled — if the flow author wants to spawn a subprocess with their own creds, that's their call. But:

1. Script steps log all env keys they override (without values) to the run log.
2. The flow-package linter (`relay publish`) warns when a script step overrides `ANTHROPIC_*` keys.
3. README §6 ("Configuration") for any flow that does this must disclose it.

## Layered defense summary

```
┌─────────────────────────────────────────┐
│ 1. inspectClaudeAuth — pre-flight check │  Catches the var, errors loudly
├─────────────────────────────────────────┤
│ 2. buildEnvAllowlist — env filtering    │  Even if (1) bypassed, var doesn't reach SDK
├─────────────────────────────────────────┤
│ 3. relay doctor — pre-run inspection    │  User checks before running anything
├─────────────────────────────────────────┤
│ 4. Pre-run banner — `bill` row          │  Visual confirmation on every run
├─────────────────────────────────────────┤
│ 5. Live progress — `spent` accumulator  │  Catches budget overruns in flight
├─────────────────────────────────────────┤
│ 6. End-of-run banner — labeled cost     │  Honest about what was billed where
└─────────────────────────────────────────┘
```

Six layers. Each one's failure is recoverable by the next. No single point of failure for the most important promise the product makes.
