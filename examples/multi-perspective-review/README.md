# multi-perspective-review

`●─▶●─▶●─▶●  multi-perspective-review`

A five-step fan-out / fan-in example. Use it to see how `step.parallel()` dispatches three independent reviewers against the same input and how a downstream step collects their handoffs into a single report.

## What it does

Three reviewers read the same source file at the same time — one looks for security issues, one for performance issues, one for readability issues. Each reviewer writes a typed JSON handoff. A final aggregation step reads all three handoffs and produces a single markdown report that ranks the findings across the three perspectives.

The flow exists to demonstrate two things: fan-out parallelism (one parallel step dispatches three prompt branches that run concurrently) and fan-in aggregation (a downstream step pulls every branch's handoff from the HandoffStore via `contextFrom` and synthesizes them). It is the smallest example that shows both halves of the pattern together.

## Prerequisites

- Node ≥ 20.10 and pnpm, same as the rest of the Relay monorepo.
- A working Claude subscription (Pro or Max). The flow runs four prompt steps — three reviewers plus the aggregator.
- A source file on disk that you want reviewed. Any text file Claude can read will do (TypeScript, Python, Go, SQL, YAML). The reviewers resolve the path you pass as `--filePath`.

## Install

This flow ships inside the Relay monorepo as a local example. There is no published package. From a clone of the repo:

```bash
pnpm install
pnpm --filter @relay/example-multi-perspective-review build
```

The build step compiles `flow.ts` to `dist/flow.js`, which is the artifact the CLI loads.

## Configure

This flow runs on your Claude subscription. Run `claude /login` once to authenticate before your first run.

Run `relay doctor` before your first run to confirm Node, the `claude` binary, auth state, and the `.relay` directory are all in order.

No per-step model overrides are set. All four prompt steps run on whichever model your provider selects by default.

## Run

From the repo root, passing the absolute path to the file you want reviewed:

```bash
relay run ./examples/multi-perspective-review --filePath="/abs/path/to/src/file.ts"
```

The path form (`./examples/multi-perspective-review`) tells the CLI to resolve the flow from a local directory instead of looking it up in the catalog. When the run completes, `report.md` lands in `.relay/runs/<runId>/artifacts/`.

### Execution topology

```
                        ┌─ reviewSecurity    ──┐
                        │  (handoff: security) │
                        │                      │
filePath ── fanOut ─────┼─ reviewPerformance   ┼──▶ aggregate ──▶ report.md
                        │  (handoff:           │    (contextFrom:
                        │   performance)       │     security,
                        │                      │     performance,
                        └─ reviewReadability   ┘     readability)
                           (handoff:
                            readability)
```

`fanOut` is a `step.parallel()` step. Its `branches` list names the three reviewer steps; the orchestrator dispatches all three at once and waits for every branch to finish before it marks `fanOut` complete. Each reviewer writes a typed JSON handoff under its own handoff id (`security`, `performance`, `readability`).

`fanOut` sets `onAllComplete: 'aggregate'`, which tells the orchestrator to run the `aggregate` step after the three branches succeed. `aggregate` declares `dependsOn: ['reviewSecurity', 'reviewPerformance', 'reviewReadability']` so it cannot start until all three reviewer steps are done, and `contextFrom: ['security', 'performance', 'readability']` so its prompt receives all three handoffs as named context blocks. That is how parallel step outputs are collected — the branches write into the HandoffStore under their own ids, and the fan-in step reads them back by id via `contextFrom`.

## Sample Output

`artifacts/report.md` looks like this:

```markdown
# Review: token-bucket.ts

## Overall assessment

The file is correct and well-structured, but performance is the weakest
perspective — the bucket recomputes its refill rate on every call. Security
and readability are both clean.

## Security (severity: none)

No findings.

## Performance (severity: medium)

The refill path does work on every acquire call that could be cached.

- refill() — recomputes the per-millisecond rate inside the hot path — hoist
  the rate into the constructor.

## Readability (severity: low)

The core logic is easy to follow; only one minor naming issue.

- tokens — single-letter parameter `t` in acquire() shadows the field name —
  rename to `amount` for clarity.

## Top priorities

1. Hoist the rate computation out of refill().
2. Rename the `t` parameter in acquire() to `amount`.
```

The exact findings and wording vary per run because every section is model-generated.

## Estimated cost and duration

- **Cost:** around $0.02 to $0.08 per run, depending on file size. Three reviewers read the file and each write a short JSON handoff (~300 tokens out), then the aggregator consumes all three handoffs plus the file path and writes a markdown document (~500 tokens out). On a Claude subscription the dollar figure is an API-equivalent estimate, not a charge on your account.
- **Duration:** 2–8 minutes. The three reviewers run concurrently, so wall-clock time is roughly one reviewer plus the aggregator, not three reviewers plus the aggregator. The longer end of the range reflects a large file or a slow model pick.

## Configuration

The flow accepts one input:

| Field | Type | Default | Notes |
|---|---|---|---|
| `filePath` | `string` | (required) | Absolute path to the source file the reviewers should read. Passed as `--filePath="/abs/path/..."`. |

## Customization

Fork the flow by copying the directory:

```bash
cp -r examples/multi-perspective-review ./my-review
cd ./my-review
```

Then edit:

- `prompts/security-review.md`, `prompts/performance-review.md`, `prompts/readability-review.md` — swap in your own review criteria, or tighten the JSON shape each reviewer returns.
- `prompts/aggregate-reviews.md` — change the report structure or the "top priorities" ranking rule.
- `flow.ts` — add a fourth reviewer branch (e.g. a test-coverage reviewer), add its step id to the `fanOut.branches` list, and add its handoff id to the aggregator's `contextFrom`. That is the entire change — parallelism is automatic.
- `package.json` — update the `name`, `description`, and the `relay` metadata block (especially `displayName` and `tags`).

Rebuild with `pnpm --filter my-review build` after any change to `flow.ts`.

## License

MIT. Copyright Ganderbite.
