---
name: claude-cli-provider
description: How `ClaudeCliProvider` spawns `claude -p` as a subprocess — invocation shape, stdin prompt convention, subprocess lifecycle (spawn → AbortSignal → SIGTERM → SIGKILL), stream-json envelope types, env allowlist with ANTHROPIC_API_KEY suppression, subscription auth contract, and the probe strategy. Trigger this skill when implementing or wiring ClaudeCliProvider, the subprocess runner, the stream-json translator, or any code that touches `claude -p` lifecycle. For the API-key billing path, see the `claude-agent-sdk` skill.
---

# claude-cli-provider

`ClaudeCliProvider` is Relay's subscription-safe provider. It spawns `claude -p` as a child process, pipes the prompt to stdin, and reads NDJSON stream-json output line by line. No API key is required or permitted — the user's stored subscription credentials do all the billing.

## When to trigger

- Implementing or changing `packages/core/src/providers/claude-cli/`.
- Wiring the subprocess runner (`process.ts`), arg builder (`args.ts`), or NDJSON translator (`translate.ts`).
- Writing tests that mock `child_process.spawn` for `claude -p`.
- Debugging auth failures, SIGTERM/SIGKILL timing, or stream-json parse errors under `ClaudeCliProvider`.

## Why two providers?

Anthropic's commercial terms prohibit using Claude Pro/Max subscription tokens through the Agent SDK. The SDK routes every call through the Anthropic API and bills against an API account — using a subscription token there is a TOS violation.

`ClaudeCliProvider` sidesteps this entirely: it spawns the user's own locally installed `claude` binary, which uses the user's own subscription credentials stored in `~/.claude/.credentials.json` or via `CLAUDE_CODE_OAUTH_TOKEN`. The user's client talks to Anthropic's servers directly. Relay never touches the API, and no API key is involved.

| | `ClaudeAgentSdkProvider` | `ClaudeCliProvider` |
|---|---|---|
| Billing | API account (`ANTHROPIC_API_KEY`) | Subscription (Pro/Max) |
| Credentials | `ANTHROPIC_API_KEY` required | `claude /login` prerequisite |
| TOS restriction | No subscription tokens | No API key |
| Subprocess | Via SDK internal | `claude -p` direct |
| Auth error on wrong creds | `SubscriptionTosLeakError` (E_TOS_LEAK_BLOCKED) | `ClaudeAuthError` |

## Invocation shape

The fixed prefix applied to every `claude -p` invocation:

```
claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --input-format text \
  --no-session-persistence \
  --verbose \
  [conditional flags]
```

Conditional flags appended when the corresponding `InvocationRequest` field is set:

| Field | Flag |
|---|---|
| `req.model` | `--model <value>` |
| `req.systemPrompt` | `--system-prompt <value>` |
| `req.tools` (non-empty) | `--allowedTools <space-separated names>` |
| `req.jsonSchema` | `--json-schema <JSON.stringify(schema)>` |
| `req.maxBudgetUsd` | `--max-budget-usd <value>` |

The binary path defaults to `claude` (resolved from `PATH`). The `binaryPath` option on `ClaudeCliProviderOptions` overrides it — used in tests to point at a mock binary.

## Subprocess lifecycle

1. **Spawn.** `child_process.spawn(binary, cliArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] })`. Spawn failures (ENOENT, EACCES) are caught synchronously and surfaced as the terminal return value — the generator never throws on spawn failure.
2. **Write prompt.** The prompt string from `InvocationRequest.prompt` is written to `child.stdin` as UTF-8, then stdin is closed (`stdin.end()`). The binary reads the full prompt before producing any output. Stdin write/close errors are treated as best-effort (the child may have already exited).
3. **Read NDJSON.** stdout is read in UTF-8 string chunks. A line buffer accumulates characters until a newline; each complete line is parsed as JSON and yielded from the async generator. Malformed lines are debug-logged and skipped — they never crash the stream.
4. **Accumulate stderr.** stderr is captured into a bounded 8 KiB ring (newest bytes win on overflow). The final stderr string is returned as part of the terminal `RunClaudeProcessResult`.
5. **Natural exit.** The `close` event fires with `{ exitCode, signal }`. Any remaining line in the stdout buffer is flushed. The generator returns `{ exitCode, stderr, signal }`.
6. **Abort.** When `abortSignal` fires, the runner sends `SIGTERM` to the child. If the child does not exit within 2 seconds, it escalates to `SIGKILL`. The kill timer is `unref()`-ed so it does not block the event loop after the child exits.

The subprocess runner (`runClaudeProcess`) is an async generator that yields parsed NDJSON envelopes and returns `RunClaudeProcessResult`. `ClaudeCliProvider.#iterate()` wraps it, threads envelopes through the translator, and resolves tool-name correlation and turn counters before yielding `InvocationStep` pairs to `stream()` and `invoke()`.

## stream-json envelope types

`claude -p --output-format stream-json` emits one JSON object per newline-terminated line (NDJSON). The envelope types `ClaudeCliProvider` handles:

| `type` | `subtype` / notes | Action |
|---|---|---|
| `system` | `subtype: "init"` | Carries session_id, model, tools list. Translator returns `[]`. |
| `system` | `subtype: "status"` or other | Informational. Translator returns `[]`. |
| `stream_event` | wraps Messages-API wire events | `claude-cli/translate.ts` unwraps the inner `event` and delegates content-block-delta events to extract text deltas. Other inner types (message_start, message_stop, content_block_stop) return `[]`. |
| `assistant` | full normalised message | Delegates to the shared `translateSdkMessage`. Emits `tool.call`, `tool.result`, `usage`. Text blocks are suppressed here to avoid double-counting with per-token `stream_event` deltas. |
| `user` | tool_result content | Delegates to `translateSdkMessage`. Emits `tool.result`. |
| `result` | final summary | Delegates to `translateSdkMessage`. Emits `usage` then `stream.end`. Carries `total_cost_usd`, `num_turns`, `stop_reason`, `session_id`. |
| `rate_limit_event` | informational | Translator returns `[]`. |

The `stream_event` envelope is unique to `claude -p` — the SDK translator does not handle it. `claude-cli/translate.ts` is a thin shim: it unwraps `stream_event`, handles `content_block_delta` events to produce `text.delta` InvocationEvents (enabling per-token streaming animation), then delegates every other top-level type to `translateSdkMessage`.

### Key fields on the `result` envelope

```
result.type             "result"
result.subtype          "success" | "error_during_execution" | ...
result.is_error         boolean
result.num_turns        number
result.stop_reason      "end_turn" | "max_turns" | ...
result.session_id       string (UUID)
result.total_cost_usd   number (API-equivalent estimate; billed to subscription)
result.usage            { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, ... }
```

`extractSdkResultSummary` and `mergeUsage` from `claude/translate.ts` handle this envelope without modification — the snake_case field names match what the existing extractor expects.

## Env allowlist contract

`buildEnvAllowlist({ providerKind: 'claude-cli', extra? })` builds the subprocess env. The rules:

**Forwarded:**
- Exact keys: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`.
- Cloud-routing exact keys: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_URL`.
- All keys with prefix `CLAUDE_` (captures `CLAUDE_CODE_OAUTH_TOKEN` and all `CLAUDE_CODE_*` vars).

**Force-suppressed:**
- `ANTHROPIC_API_KEY` — set to `undefined` even if the host has it set. The user picked the subscription path; a stray API key in the env must not silently route the run through the API. This is the TOS-safety boundary for `ClaudeCliProvider`.

**Caller-supplied extras** are merged last and always win — they represent explicit per-step or per-run env that must reach the subprocess unchanged, even if the same key would otherwise have been suppressed.

The return type is `Record<string, string | undefined>`. `undefined` values instruct the SDK merge layer (used by `ClaudeAgentSdkProvider`) to strip inherited vars. For the direct-spawn path (`ClaudeCliProvider`), the runner filters out `undefined` values before passing the env to `child_process.spawn`, giving a clean `Record<string, string>`.

## Auth contract

`ClaudeCliProvider.authenticate()` delegates to `inspectClaudeAuth({ providerKind: 'claude-cli' })`. The rules:

1. Cloud routing (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`) → `ok(bedrock | vertex | foundry)`. Subscription check is skipped.
2. `CLAUDE_CODE_OAUTH_TOKEN` set → `ok(subscription, token mode)`.
3. `~/.claude/.credentials.json` present (detected via `fs.existsSync`) → `ok(subscription, interactive)`. The file is not parsed — presence is sufficient. A corrupt file will fail loudly at runtime with the binary's own error.
4. Otherwise (including `ANTHROPIC_API_KEY`-only) → `err(ClaudeAuthError)` with remediation: `run \`claude /login\`, or run \`relay init\` and choose claude-agent-sdk.`

`ANTHROPIC_API_KEY` is explicitly not a valid fallback — the user chose `ClaudeCliProvider`, which means they want subscription billing. An API key in the env is something to strip at the subprocess boundary, not something to silently route the run through.

### claude /login prerequisite

Before `ClaudeCliProvider` can pass auth, the user must have authenticated the local `claude` binary at least once:

```
claude /login
```

This writes credentials to `~/.claude/.credentials.json` and sets up the OAuth token. `relay doctor` checks for this file (or `CLAUDE_CODE_OAUTH_TOKEN`) and surfaces a clear error if neither is present.

### Binary probe strategy

After the auth decision, `inspectClaudeAuth` confirms the binary exists by spawning:

```
claude --version
```

with a 5-second timeout and a minimal env (PATH, HOME, USER, LANG, LC_ALL, TZ, TMPDIR, SHELL). On any failure (ENOENT, non-zero exit, timeout), it returns `err(ClaudeAuthError)` with install instructions:

```
npm install -g @anthropic-ai/claude-code
```

The probe runs after the policy check — a misconfigured machine never reaches a subprocess.

## Feature parity with ClaudeAgentSdkProvider

`ClaudeCliProvider` and `ClaudeAgentSdkProvider` expose the same `Provider` interface and the same `ProviderCapabilities` object. Both backends ultimately drive the same `claude` binary, so capabilities are identical:

- Streaming: `true`
- Structured output: `true` (via `--json-schema`)
- Tools: `true` (via `--allowedTools`)
- Built-in tools: `Read Write Edit Glob Grep Bash WebFetch WebSearch Task TodoWrite`
- Multimodal: `true`
- Budget cap: `true` (via `--max-budget-usd`)
- Max context: 200 000 tokens

No provider-level retries. Step retries are owned by the Runner.
