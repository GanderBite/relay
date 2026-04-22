# SDK Streaming — Message Taxonomy

The SDK's `query()` returns an async iterator. Each yielded message has a discriminator that tells you what kind of event it is. Relay's `translateSdkMessage` (sprint 4 task_28) maps these to `InvocationEvent`s.

## Message kinds you actually care about

The SDK is in active development; field names may shift across versions. Don't bind to specific shapes too tightly — wrap each in a defensive try/catch and emit `null` on unrecognized shapes.

### Assistant text deltas
```ts
// Roughly: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
// or:      { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
→ { type: 'text.delta', delta: '...' }
```

### Tool use
```ts
// { type: 'tool_use', name: 'Read', input: { ... } }
→ { type: 'tool.call', name, input }
```

### Tool result
```ts
// { type: 'tool_result', tool_use_id: '...', is_error?: bool, content: ... }
→ { type: 'tool.result', name: <correlated from tool_use_id>, ok: !is_error }
```

The tool_result references the tool_use_id, not the name — you need to remember the (id → name) map across the stream.

### Usage events
```ts
// On final assistant message or stream end:
// { usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }
→ { type: 'usage', usage: {
     inputTokens: input_tokens ?? 0,
     outputTokens: output_tokens ?? 0,
     cacheReadTokens: cache_read_input_tokens ?? 0,
     cacheCreationTokens: cache_creation_input_tokens ?? 0,
   } }
```

Multiple usage events may arrive across a multi-turn conversation. Use `mergeUsage` to accumulate.

### Turn boundaries
```ts
// { type: 'message_start' / 'message_stop' } or analogous
→ { type: 'turn.start', turn: N }
   { type: 'turn.end',   turn: N }
```

Increment `N` on each `turn.start`. The final `numTurns` on `InvocationResponse` is the count of `turn.end` events.

### Stop reason
The final assistant message includes a `stop_reason` field. Capture it on the InvocationResponse.

### System / informational messages
Anything else (system prompts echoed back, internal SDK logs, init messages) — return `null`. Don't pollute the event stream.

## InvocationResponse aggregation pattern

```ts
async invoke(req, ctx) {
  const startMs = Date.now();
  let text = '';
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let numTurns = 0;
  let model = req.model ?? 'sonnet';
  let stopReason: string | null = null;
  let lastRaw: unknown = null;

  for await (const evt of this.stream!(req, ctx)) {
    if (evt.type === 'text.delta') text += evt.delta;
    else if (evt.type === 'usage') usage = mergeUsage(usage, evt.usage);
    else if (evt.type === 'turn.end') numTurns += 1;
    // tool.call / tool.result / turn.start: surface via logger but no aggregation
  }

  const costUsd = computeCostFromUsage(usage, model);
  return { text, usage, costUsd, durationMs: Date.now() - startMs, numTurns, model, stopReason, raw: lastRaw };
}
```

## mergeUsage helper

```ts
function mergeUsage(a: NormalizedUsage, b: Partial<NormalizedUsage>): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: a.cacheCreationTokens + (b.cacheCreationTokens ?? 0),
  };
}
```

Sum, don't max. Across turns, usage accumulates.

## AbortSignal wiring

```ts
const sdkStream = query({
  prompt: req.prompt,
  options: {
    abortSignal: ctx.abortSignal,
    // ...
  },
});

// On abort, the SDK stops yielding messages and the iterator completes.
// Don't try to call .return() yourself — let the iterator drain naturally.
```

When the parent AbortController fires (Ctrl-C, timeout, parent step failure), the SDK respects it. Your job is just to plumb it through.

## Live state writes

For each `usage` event during streaming, write a partial state file at `<runDir>/live/<runnerId>.json`. The CLI's `ProgressDisplay` polls these to render the live cost / token deltas. Keep writes cheap — debounce to ~100ms if usage events are very frequent.

## Defensive translation

```ts
export function translateSdkMessage(msg: unknown): InvocationEvent | null {
  try {
    if (!msg || typeof msg !== 'object') return null;
    const m = msg as any;
    if (m.type === 'text' || m.type === 'content_block_delta') {
      const delta = extractTextDelta(m);
      return delta ? { type: 'text.delta', delta } : null;
    }
    // ...other cases...
    return null;  // unknown shape
  } catch {
    return null;  // never throw out of the translator
  }
}
```

The translator never throws. An unrecognized message is a `null` return; the runner ignores nulls.
