# hello-world-mocked

`●─▶●─▶●─▶●  hello-world-mocked`

The mocked twin of [`hello-world`](../hello-world). Runs the same two-step flow against a `MockProvider` — no Claude binary, no subscription, no API key. Proves that the `Provider` abstraction holds: the flow definition is identical, only the orchestrator's provider registry changes.

## What it does

Runs two prompt steps against canned responses wired up in `run-mocked.ts`:

1. `greet` — pretends to ask Claude for a JSON greeting, returns the canned document `{ "greeting": "..." }`, and writes it as the `greeting` handoff.
2. `summarize` — pretends to ask Claude to render the greeting as markdown, returns the canned markdown body, and writes it to `greeting.md` as the run's artifact.

The flow graph, prompt files, input schema, and output artifact match `hello-world` byte for byte. The only difference is the entry point: `run-mocked.ts` constructs a `ProviderRegistry` containing a `MockProvider` and hands it to `createOrchestrator`, rather than relying on a default Claude provider.

Use this flow when you want to exercise Relay end-to-end without spending a Claude turn — CI, smoke tests, offline demos, or any environment without a subscription.

## Sample output

A successful run writes `greeting.md` under the run directory and prints the final summary to stdout:

```
run-mocked: status=succeeded
run-mocked: runId=a1b2c3
run-mocked: runDir=/path/to/.relay/runs/a1b2c3
run-mocked: artifacts=greeting.md
run-mocked: durationMs=12
```

The artifact itself:

```markdown
# Hello, World

> Welcome to Relay, World. Good to have you here.

This flow ran two prompt steps. The first produced a JSON handoff named `greeting`; the second turned that handoff into this markdown artifact. Both steps ran against a MockProvider with canned responses, so no Claude subprocess was spawned.
```

## Estimated cost and duration

| Metric | Value |
|---|---|
| Cost (USD) | 0.00 — nothing is invoked |
| Duration  | under 1 second on a laptop |

The `MockProvider` never spawns a subprocess and never calls the network. Every response is a literal defined in `run-mocked.ts`.

## Install

This example ships inside the Relay monorepo rather than the catalog, so install is a workspace build:

```
pnpm install
pnpm --filter hello-world-mocked build
```

## Run

```
pnpm --filter hello-world-mocked run-mocked            # greets "World"
pnpm --filter hello-world-mocked run-mocked -- Michal  # greets "Michal"
```

Under the hood the `run-mocked` script executes `node dist/run-mocked.js`. The optional first positional argument overrides the default name.

After a run, inspect the artifact and state:

```
ls .relay/runs/<runId>
cat .relay/runs/<runId>/artifacts/greeting.md
```

## Configuration

`run-mocked.ts` exposes two knobs, both directly in the source for pedagogy:

- **Input** — `{ name: string }`. Change the CLI argument or edit the `process.argv[2]` fallback.
- **Canned responses** — edit the `responses` map passed to `new MockProvider(...)`. Keys are step ids (`greet`, `summarize`). Values are full `InvocationResponse` objects; the helper `cannedResponse(text)` handles the usage/model/stopReason boilerplate.

Every `MockProvider` key must match a step id in `flow.ts`. Missing a key surfaces as `StepFailureError: MockProvider: no response configured for stepId "<id>"` on the first attempt, which then consumes the retry budget and fails the run.

## Environment

This flow needs no Claude subscription and no API key. It runs against a `MockProvider` wired up in `run-mocked.ts`, so the `ANTHROPIC_API_KEY` guard never fires and no subprocess is spawned. Use it in CI, offline demos, or any environment where you want to exercise Relay end-to-end without spending a Claude turn. See `docs/billing-safety.md` for the full auth precedence and the opt-in paths that apply to flows that do call the model.

## Customization

Typical starting points:

- **Add a step.** Add a new entry to `flow.ts`'s `steps` map, add the prompt file under `prompts/`, and add a matching entry to the `MockProvider`'s `responses` map. Keys must match.
- **Return different text per attempt.** `MockProvider` accepts a function `(req, ctx) => InvocationResponse` in place of a static response — use `ctx.attempt` to return a different value on retries.
- **Point at a real provider.** Replace the `MockProvider`/`ProviderRegistry` setup with the default registry (or call `createOrchestrator()` with no `providers` override). `flow.ts` itself stays identical — that is the whole point of the abstraction.

## License

MIT. See the repository root.
