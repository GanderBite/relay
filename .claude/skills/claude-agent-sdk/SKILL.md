---
name: claude-agent-sdk
description: How to use `@anthropic-ai/claude-agent-sdk` correctly inside Relay — the `query()` async iterator, options shape, message envelope translation, environment passthrough, abort signal wiring, authentication precedence (subscription vs API key), and the safety guard that prevents `ANTHROPIC_API_KEY` from silently routing tokens to a paid API account. Trigger this skill whenever code imports the SDK, when implementing the `ClaudeProvider`, the auth inspector, the env allowlist, the SDK→InvocationEvent translator, or the doctor command. Critical for sprint 4.
---

# Claude Agent SDK — How Relay Uses It

The SDK is `@anthropic-ai/claude-agent-sdk`. It is itself a subprocess wrapper around the `claude` CLI binary. **The SDK does not provide its own subscription billing safety guard — Relay enforces it before every call.** That is the most important fact in this skill.

## What the SDK is

- Located at npm package `@anthropic-ai/claude-agent-sdk`.
- Wraps the user's installed `claude` binary (which they install via `npm install -g @anthropic-ai/claude-code` or similar).
- Respects the same auth precedence as the binary: `ANTHROPIC_API_KEY` first, then `CLAUDE_CODE_OAUTH_TOKEN`, then interactive subscription credentials, then cloud env vars.
- Emits typed messages over an async iterator instead of raw stream-json line parsing.

## The query() entry point (canonical usage)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = query({
  prompt: '<the rendered prompt with handoff context blocks>',
  options: {
    model: 'sonnet' | 'haiku' | 'opus' | '<fully-qualified-id>',
    allowedTools: ['Read', 'Glob', 'Grep'],   // names of built-in tools
    systemPrompt: '...optional system override...',
    output: req.jsonSchema ? { schema: req.jsonSchema } : undefined,
    env,                  // explicit env object (DO NOT inherit process.env)
    abortSignal,          // from a parent AbortController
  },
});

for await (const msg of stream) {
  // msg shapes (typed by the SDK): assistant text deltas, tool_use, tool_result,
  // usage metadata, system events, turn boundaries.
}
```

## Translating SDK messages to InvocationEvent (§4.6.3)

Relay's `Provider` interface speaks `InvocationEvent`s, not raw SDK messages. The translator lives at `packages/core/src/providers/claude/translate.ts`.

Mapping rules:

| SDK message shape | Emit |
|---|---|
| Assistant text delta | `{ type: 'text.delta', delta }` |
| Tool use start | `{ type: 'tool.call', name, input? }` |
| Tool result | `{ type: 'tool.result', name, ok }` |
| `message.usage` populated | `{ type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } }` |
| Turn start | `{ type: 'turn.start', turn }` |
| Turn end | `{ type: 'turn.end', turn }` |
| Anything else (purely informational) | return `null`, runner ignores |

**Translate, don't expose.** The SDK uses snake_case (`input_tokens`, `cache_read_input_tokens`); Relay uses camelCase. The translator is the boundary — nothing downstream sees snake_case.

**Always populate `usage`** on the final InvocationResponse, even if you have to merge multiple partial usage events. Cost tracking depends on it.

## Authentication precedence

The `claude` binary (and therefore the SDK) checks credentials in this order:

1. `ANTHROPIC_API_KEY` env var → API account billing
2. `CLAUDE_CODE_USE_BEDROCK=1` → AWS Bedrock account
3. `CLAUDE_CODE_USE_VERTEX=1` → Google Vertex account
4. `CLAUDE_CODE_USE_FOUNDRY=1` → Azure Foundry account
5. `CLAUDE_CODE_OAUTH_TOKEN` env var → subscription billing (long-lived OAuth)
6. Interactive `~/.claude/credentials` → subscription billing

Relay's `inspectClaudeAuth` enforces additional rules that the SDK does not:

- If `ANTHROPIC_API_KEY` is set AND user did not opt in (`runner.allowApiKey()` OR `RELAY_ALLOW_API_KEY=1` env), **throw `ClaudeAuthError` before calling the SDK.** This is the §8.1 contract — non-negotiable.
- Verify the `claude` binary exists by spawning `claude --version` with a 5-second timeout. On missing binary, throw with install instructions.
- Return a normalized `AuthState` with `billingSource: 'subscription' | 'api-account' | 'bedrock' | 'vertex' | 'foundry' | 'local' | 'unknown'`.

See `references/auth-precedence.md` for the full table.

## Env passthrough

Never pass raw `process.env` to the SDK. Build an explicit allowlist:

- Always include: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`.
- Always include vars starting with `CLAUDE_*` (oauth token, use-bedrock, use-vertex, use-foundry, all `CLAUDE_CODE_*`).
- Include `ANTHROPIC_*` ONLY when `allowApiKey: true`.
- Merge any caller-provided `extraEnv` on top.

This contains both the safety surface (no surprise API key leak) and the test surface (env is reproducible).

See `references/streaming-events.md` for the full SDK message taxonomy and `references/auth-precedence.md` for auth states.

## Cost calculation

The SDK reports usage in tokens. To get cost:

- For published models, use Anthropic's per-token pricing: input, output, cache_read, cache_creation each priced separately.
- The `costUsd` field in `InvocationResponse` is an **API-equivalent estimate** — it's what the user would pay if they were billed by the API. When billed via subscription, the actual charge is zero against API quota; tokens count against subscription.
- Surface this in CLI banners as `(estimated api equivalent; billed to subscription)` when billingSource is subscription.

## Pitfalls

1. **Don't inline the API-key check.** It lives in `inspectClaudeAuth` — every code path that calls `query()` must have already passed authentication.
2. **Don't add provider-level retries.** The Runner owns retries at the step level. The SDK's network retries (rate limits, transient 429/503) are kept enabled.
3. **Don't swallow `ClaudeAuthError`.** Propagate it — the CLI's exit-code mapper turns it into exit 3.
4. **Don't emit raw SDK message shapes from `stream()`.** Translate to `InvocationEvent`.
5. **Don't hold onto the SDK's async iterator after the run.** Drain it or call its abort signal — leaked iterators leak subprocess handles.

## Validation note

The working OAuth-token demo at `weidwonder/claude_agent_sdk_oauth_demo` is referenced in tech spec §3.4 — it confirms `CLAUDE_CODE_OAUTH_TOKEN` correctly triggers subscription billing in the SDK. If something looks broken with subscription mode, compare against that demo before assuming the SDK changed.
