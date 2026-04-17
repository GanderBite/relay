# Auth Precedence — Full Table

The `claude` binary (and the SDK) check credentials in this strict order. The first hit wins; later sources are ignored.

| Order | Source | Billing | How user sets it up |
|---|---|---|---|
| 1 | `ANTHROPIC_API_KEY` env | API account (paid per token) | `export ANTHROPIC_API_KEY=sk-ant-...` |
| 2 | `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds | AWS Bedrock account | Standard AWS env / IAM |
| 3 | `CLAUDE_CODE_USE_VERTEX=1` + GCP creds | Google Vertex account | Standard GCP env / ADC |
| 4 | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure creds | Azure Foundry | Standard Azure env |
| 5 | `CLAUDE_CODE_OAUTH_TOKEN` env | Subscription (Pro/Max/Team) | `claude setup-token` once → export |
| 6 | Interactive (`~/.claude/credentials`) | Subscription | `claude /login` once |

## Relay's normalized AuthState

```ts
export interface AuthState {
  ok: boolean;
  billingSource: 'subscription' | 'api-account' | 'bedrock' | 'vertex' | 'foundry' | 'local' | 'unknown';
  detail: string;       // Human-readable. e.g. "Pro subscription via CLAUDE_CODE_OAUTH_TOKEN"
  account?: string;     // The user/org identifier the provider is authenticated as
  warnings?: string[];  // e.g. "CLAUDE_CODE_OAUTH_TOKEN expires in 14 days"
}
```

`billingSource: 'local'` is reserved for the MockProvider (and any future on-machine providers like Ollama).

## The Relay safety contract (§8.1.2)

```
1. Inspect process.env BEFORE calling the SDK.
2. If ANTHROPIC_API_KEY is set AND
   !allowApiKey AND
   process.env.RELAY_ALLOW_API_KEY !== '1':
     throw ClaudeAuthError with the §8.1 remediation message.
3. If user explicitly opted in (allowApiKey: true OR env var set):
     emit a single warning per run: "ANTHROPIC_API_KEY active — billing
     to API account, not subscription"
4. The `relay doctor` command surfaces this state without running a flow.
5. The pre-run banner displays the active billing mode unconditionally.
```

## The remediation message

When `ClaudeAuthError` is thrown for the API-key conflict, the message reads:

```
ANTHROPIC_API_KEY is set; relay defaults to subscription billing.
Unset it, or call runner.allowApiKey(), or set RELAY_ALLOW_API_KEY=1.
```

The CLI's `formatError` (sprint 6 task_46) turns this into the §6.2 doctor block format with `fix:` / `permanent:` / `override:` lines.

## Detection logic for `inspectClaudeAuth`

```ts
async function inspectClaudeAuth(opts: { allowApiKey?: boolean }): Promise<AuthState> {
  const env = process.env;
  const apiKey = !!env.ANTHROPIC_API_KEY;
  const opted = !!opts.allowApiKey || env.RELAY_ALLOW_API_KEY === '1';

  // 1. Safety check — highest priority.
  if (apiKey && !opted) {
    throw new ClaudeAuthError(
      'ANTHROPIC_API_KEY is set; relay defaults to subscription billing. ' +
      'Unset it, or call runner.allowApiKey(), or set RELAY_ALLOW_API_KEY=1.'
    );
  }

  // 2. Verify the binary exists.
  await assertClaudeBinary();   // spawns `claude --version` with 5s timeout

  // 3. Determine billing source.
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') return { ok: true, billingSource: 'bedrock', detail: 'AWS Bedrock' };
  if (env.CLAUDE_CODE_USE_VERTEX === '1')  return { ok: true, billingSource: 'vertex', detail: 'Google Vertex' };
  if (env.CLAUDE_CODE_USE_FOUNDRY === '1') return { ok: true, billingSource: 'foundry', detail: 'Azure Foundry' };

  if (apiKey) {
    return {
      ok: true,
      billingSource: 'api-account',
      detail: 'ANTHROPIC_API_KEY (opt-in)',
      warnings: ['billing to API account, not subscription'],
    };
  }

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ok: true, billingSource: 'subscription', detail: 'OAuth token (CLAUDE_CODE_OAUTH_TOKEN)' };
  }

  // Default: assume interactive subscription credentials are present.
  // We can't verify without calling claude — rely on the binary's own auth.
  return { ok: true, billingSource: 'subscription', detail: 'interactive (~/.claude/credentials)' };
}
```

## CI gotchas

- CI runners (GitHub Actions, GitLab CI, etc.) often inject `ANTHROPIC_API_KEY` automatically. Always run `relay doctor` as the first step in CI so the build fails loudly if the env is misconfigured.
- For CI, generate `CLAUDE_CODE_OAUTH_TOKEN` once via `claude setup-token` and store it as a CI secret. This token is subscription-billed.
- `CLAUDE_CODE_OAUTH_TOKEN` can expire — the AuthState should surface a warning when expiry is < 14 days. (Implementation in v1.x; flag as a TODO in v1.)

## Issue references

- [Claude Code #37686](https://github.com/anthropics/claude-code/issues/37686) — `ANTHROPIC_API_KEY` silently routing past subscription. The reason this safety contract exists.
- [Claude Code #20976](https://github.com/anthropics/claude-code/issues/20976) — confusion about subscription vs API billing in cost output. The reason banners label cost as "estimated api equivalent."
