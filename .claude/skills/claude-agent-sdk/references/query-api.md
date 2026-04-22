# query() API — Options and Patterns

The single SDK entry point Relay uses. The `query()` function takes `{ prompt, options }` and returns an async iterator of message objects.

## Full options shape (as Relay uses it)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = query({
  prompt: string,    // already-rendered prompt with baton context blocks
  options: {
    // Model selection
    model?: 'sonnet' | 'haiku' | 'opus' | string,  // shortname or fully-qualified id

    // Tool gating
    allowedTools?: string[],   // names from ClaudeProvider.capabilities.builtInTools
    disallowedTools?: string[], // typically not used; allowedTools is preferred

    // System prompt override
    systemPrompt?: string,

    // Structured output (forwarded as --json-schema to claude binary)
    output?: { schema: object },  // already converted Zod → JSON Schema

    // Per-call budget cap
    maxBudgetUsd?: number,

    // Environment — explicit, not inherited
    env?: Record<string, string>,

    // Cancellation
    abortSignal?: AbortSignal,

    // Working directory for tools (Read/Write/etc.) — Relay sets this to the run dir
    cwd?: string,

    // MCP server wiring (not used in v1)
    mcpServers?: Record<string, McpServerConfig>,
  },
});
```

## Built-in tool names (capabilities.builtInTools)

```ts
[
  'Read', 'Write', 'Edit',
  'Glob', 'Grep',
  'Bash',
  'WebFetch', 'WebSearch',
  'Task',
  'TodoWrite',
]
```

This is the v1 list. The SDK may add more; update `ClaudeProvider.capabilities.builtInTools` when it does. Step authors specify a subset via `step.prompt({ tools: ['Read', 'Glob'] })`.

## Iteration pattern

```ts
for await (const msg of stream) {
  const evt = translateSdkMessage(msg);
  if (evt === null) continue;
  yield evt;   // for the stream() generator
  // OR aggregate into InvocationResponse fields
}
```

Don't break out of the loop unless aborting — the SDK relies on the iterator being fully consumed for clean shutdown of the underlying subprocess.

## Calling pattern in ClaudeProvider

```ts
async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
  const env = buildEnvAllowlist({ allowApiKey: this.opts.allowApiKey, extra: this.opts.extraEnv });

  const sdkStream = query({
    prompt: req.prompt,
    options: {
      model: req.model ?? 'sonnet',
      allowedTools: req.tools,
      systemPrompt: req.systemPrompt,
      output: req.jsonSchema ? { schema: req.jsonSchema } : undefined,
      maxBudgetUsd: req.maxBudgetUsd,
      env,
      abortSignal: ctx.abortSignal,
      cwd: process.cwd(),
    },
  });

  for await (const sdkMsg of sdkStream) {
    const evt = translateSdkMessage(sdkMsg);
    if (evt !== null) yield evt;
  }
}
```

## What `prompt` should already contain

By the time you call `query()`, the prompt string has been:

1. Read from the step's `promptFile`.
2. Run through `assemblePrompt({ promptBody, handoffs, inputVars })` — which substitutes `{{name.path}}` placeholders and prepends `<context name="...">...</context>` blocks.
3. Wrapped in `<prompt>...</prompt>` per §4.5.2.

The SDK doesn't know or care about handoffs — it just sees the assembled string.

## Errors from query()

The SDK throws on:

- Network failure not caught by its internal retries.
- The claude binary missing (after spawn).
- Auth failure surfaced from the binary.
- Abort signal fired (throws an AbortError-like).

Wrap each `for await` in a try/catch. On abort, exit cleanly (don't propagate AbortError as a runner failure — the Orchestrator already knows). On other errors, wrap in `StepFailureError` with the runner ID and re-throw.

## Don't do

- **Don't pass `process.env` directly.** Use `buildEnvAllowlist` always.
- **Don't omit `abortSignal`.** A long-running prompt that ignores Ctrl-C breaks the trust contract.
- **Don't call `query()` from outside `ClaudeProvider`.** The provider is the only code path that touches the SDK.
- **Don't await each message individually with a separate `then`.** The async iterator already serializes.
- **Don't swallow the iterator.** Always drain it (or abort properly) — leaked iterators leak subprocess handles.

## Estimating cost

The SDK reports tokens, not dollars. Compute USD from per-model pricing. Pricing tables shift; keep them in a single constant file (`packages/core/src/providers/claude/pricing.ts`) and source them from a single doc reference (e.g., Anthropic's official pricing page) so updates are contained.

For v1 a static table is fine. For v1.x, consider fetching pricing at startup from a known JSON endpoint with a fallback to the pinned table.
