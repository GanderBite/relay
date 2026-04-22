# claude -p stream-json output samples

Captured from a real `claude` binary (Claude Code CLI v2.1.117) on 2026-04-22 by running:

```bash
echo 'say hello in exactly three words' | claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --no-session-persistence
```

The CLI emits NDJSON — one JSON object per newline-terminated line. Reproduced
below verbatim, lightly reformatted (one envelope per code block) for reading.

> Note: the `claude` binary in this environment fronts a multi-tool harness, so
> the capture also includes `system.subtype: "hook_started" | "hook_response"`
> envelopes ahead of the LLM stream. Bare-CLI installs will not emit those —
> they are not part of the documented stream-json contract. The envelopes the
> ClaudeCliProvider must handle are: `system.subtype: "init"`, `stream_event`,
> `assistant`, `user`, `result`, and the optional `rate_limit_event`.

---

## 1. system.init — capabilities advertised by the running CLI

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/.../relay",
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "tools": ["Task", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Read", "Write", "WebFetch", "WebSearch", "TodoWrite", "..."],
  "mcp_servers": [],
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "slash_commands": ["init", "review", "..."],
  "apiKeySource": "none",
  "claude_code_version": "2.1.117",
  "output_style": "default",
  "agents": ["..."],
  "skills": ["..."],
  "plugins": [],
  "uuid": "a1134f43-dbca-484f-a351-795547525195",
  "memory_paths": { "auto": "/Users/.../memory/" },
  "fast_mode_state": "off"
}
```

## 2. system.status — transient state envelope (informational)

```json
{
  "type": "system",
  "subtype": "status",
  "status": "requesting",
  "uuid": "5c23b4bb-0cb6-4acb-b20d-5751207d7b97",
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e"
}
```

## 3. stream_event: message_start — opens an assistant turn

The CLI wraps the SDK's wire-level events inside a `stream_event` envelope. The
inner shape under `event` matches the Anthropic Messages-API streaming format
exactly (snake_case fields, including `usage`), unlike the `assistant` envelope
shown later, which is the SDK's normalised per-message form.

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "model": "claude-sonnet-4-6",
      "id": "msg_01NP4Fm8tu9p5Krc7xPGAeL7",
      "type": "message",
      "role": "assistant",
      "content": [],
      "stop_reason": null,
      "stop_sequence": null,
      "stop_details": null,
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 23980,
        "cache_read_input_tokens": 0,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 23980 },
        "output_tokens": 1,
        "service_tier": "standard",
        "inference_geo": "not_available"
      }
    }
  },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "afe89a85-9ddc-4dd8-8fb3-73eab3365d3c",
  "ttft_ms": 1183
}
```

## 4. stream_event: content_block_start

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "text", "text": "" }
  },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "a47dcc71-7019-4589-86eb-93171dbb10fe"
}
```

## 5. stream_event: content_block_delta — token-by-token text delta

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Hello" }
  },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "2147c516-d7b9-4a42-a4a4-42eb5f9d0fbd"
}
```

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": " there, friend." }
  },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "5541fa34-e794-4def-a59c-9b740762379c"
}
```

## 6. assistant — SDK's normalised assistant message envelope

This envelope is emitted IN ADDITION to the per-token deltas above. It carries
the full assembled `content` plus a (partial) `usage` snapshot. The shape under
`message` matches what `@anthropic-ai/claude-agent-sdk` yields to the existing
`translateSdkMessage()` translator.

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_01NP4Fm8tu9p5Krc7xPGAeL7",
    "type": "message",
    "role": "assistant",
    "content": [{ "type": "text", "text": "Hello there, friend." }],
    "stop_reason": null,
    "stop_sequence": null,
    "stop_details": null,
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 23980,
      "cache_read_input_tokens": 0,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 23980 },
      "output_tokens": 1,
      "service_tier": "standard",
      "inference_geo": "not_available"
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "uuid": "501eef2f-1da2-49d8-808e-e399d7865a1e"
}
```

## 7. stream_event: content_block_stop, message_delta, message_stop

```json
{
  "type": "stream_event",
  "event": { "type": "content_block_stop", "index": 0 },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "f4cf8b57-1466-41dc-abe4-d9e9e2446a20"
}
```

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": { "stop_reason": "end_turn", "stop_sequence": null, "stop_details": null },
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 23980,
      "cache_read_input_tokens": 0,
      "output_tokens": 8,
      "iterations": [
        {
          "input_tokens": 2,
          "output_tokens": 8,
          "cache_read_input_tokens": 0,
          "cache_creation_input_tokens": 23980,
          "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 23980 },
          "type": "message"
        }
      ]
    },
    "context_management": { "applied_edits": [] }
  },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "409d07a4-eb95-48cf-9dd6-650c8717066a"
}
```

```json
{
  "type": "stream_event",
  "event": { "type": "message_stop" },
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "parent_tool_use_id": null,
  "uuid": "7ce91f4e-ecb5-4158-bb69-e690169b3c21"
}
```

## 8. rate_limit_event — informational rate-limit notification

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed_warning",
    "resetsAt": 1777014000,
    "rateLimitType": "seven_day",
    "utilization": 0.94,
    "isUsingOverage": false,
    "surpassedThreshold": 0.75
  },
  "uuid": "899122b2-d12b-4af8-a6c8-ba2b94dbfd9b",
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e"
}
```

## 9. result — final envelope, carries totals + summary text

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 2169,
  "duration_api_ms": 1465,
  "num_turns": 1,
  "result": "Hello there, friend.",
  "stop_reason": "end_turn",
  "session_id": "6f5b82b2-0e07-4a31-8d84-694ca191674e",
  "total_cost_usd": 0.090051,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 23980,
    "cache_read_input_tokens": 0,
    "output_tokens": 8,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 23980, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "",
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 8,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 23980,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 23980 },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-sonnet-4-6": {
      "inputTokens": 2,
      "outputTokens": 8,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 23980,
      "webSearchRequests": 0,
      "costUSD": 0.090051,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "3f638d6a-21de-4b35-a6ca-9a15dd8a85bd"
}
```

---

## Translator-reuse decision input (for task_120)

Comparing against `packages/core/src/providers/claude/translate.ts` shapes:

| stream-json envelope | Already handled by `translateSdkMessage`? |
|---|---|
| `{type:"system", subtype:"init"\|"status"\|...}` | YES — top-level `type === 'system'` returns `[]`. |
| `{type:"assistant", message:{...content, usage}}` | YES — exact same shape; emits `text.delta` per text block (filtered upstream as redundant), `tool.call`, `tool.result`, then `usage`. |
| `{type:"user", message:{content:[{type:"tool_result"...}]}}` | YES — explicit branch in translator. |
| `{type:"result", ..., usage, stop_reason}` | YES — emits `usage` then `stream.end`. The CLI variant has additional fields (`total_cost_usd`, `modelUsage`, `permission_denials`) that the translator ignores by design. |
| `{type:"stream_event", event:{type:"message_start"\|"content_block_delta"\|"message_stop"\|...}}` | NO — the wrapping envelope is unique to `claude -p`. The translator only matches on the OUTER `type` field; a top-level `"stream_event"` falls through to the unrecognized branch and yields `[]`. |
| `{type:"rate_limit_event", ...}` | NO (falls through) — informational only; `[]` is correct. |

Two practical paths for task_120:

1. **Reuse `translateSdkMessage` directly.** Lose the per-token text deltas
   carried by `stream_event.content_block_delta` (acceptable — the `assistant`
   envelope below them carries the full assembled text, and the existing
   translator skips that to avoid double-counting; we'd flip that suppression
   for the CLI path so the `assistant.text` block IS emitted as a single
   `text.delta`). Token-level streaming animation degrades to per-message
   chunks, but `invoke()` and `stream()` semantics (final text + usage +
   stopReason + sessionId) remain correct.

2. **Write a thin `claude-cli/translate.ts` wrapper.** Unwrap `stream_event`
   envelopes (delegate the inner `event` to a content-block-delta translator)
   then delegate every other top-level type to `translateSdkMessage`. Preserves
   token-level deltas. Recommended if the live progress display matters.

Both options keep `extractSdkResultSummary` and `mergeUsage` reusable as-is —
the `result` envelope's snake_case `stop_reason`, `num_turns`, `session_id`,
and `usage` fields all line up with the existing extractor.
