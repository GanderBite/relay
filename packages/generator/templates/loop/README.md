# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

An iterative implement-feedback-review flow. One outer step (`fix_loop`) wraps three inner steps that run in sequence: `implement` makes a change, `feedback` pauses the run to collect a free-form human comment on the implementation, then `review` inspects both the change and your comment and decides `continue` or `done`. When `review` returns `decision: 'done'`, the loop exits. Otherwise the body re-runs — `implement` reads the prior `review.feedback` and the prior iteration's `feedback` answers from their handoffs and addresses each point. The loop caps at five iterations to bound cost; raise or lower the cap in `flow.ts` to fit your task.

Use this template when the work has a clear acceptance check (a test passes, a lint rule is clean, a refactor is structurally correct), the model can make incremental progress between iterations, and you want to steer each iteration with a short human note.

## Sample output

The flow emits three handoffs per iteration: `implementation` (`{ summary, files[] }`), `feedback` (`{ comments }` — the answers you provided), and `review` (`{ decision, feedback? }`). The final `review` handoff has `decision: 'done'`. Add a transcript or screenshot to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.10–$1.00 per run on the default sonnet model (billed to your subscription on Pro/Max). Cost scales linearly with the number of iterations.
- **Duration:** 5–30 minutes — one to five iterations of two prompts plus one human pause each.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --task="describe the change you want made"
```

### Pause and answer each iteration

Each iteration of the loop pauses after `implement` and waits for you to answer one question — `comments`, a free-form note on the implementation. The CLI prints the run id and the prompt; in another terminal, answer with:

```bash
relay answer <run-id> --comments "looks good, tighten the error handling"
```

Leave the answer blank to approve the iteration without notes — `review` will still run and decide `continue` or `done`. The answers are published as the `feedback` handoff and read by the next `implement` iteration along with the prior `review.feedback`.

## Development

To run the flow locally from its directory:

```bash
pnpm install --ignore-workspace  # required inside a pnpm workspace root
relay run .
```

If `pnpm install` appears to install nothing, you are inside a pnpm workspace
that does not declare this directory as a member. The `--ignore-workspace`
flag installs dependencies for this package in isolation.

## Configuration

The flow accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `task` | `string` | (required) | The task to implement. Be specific — the model reads this verbatim each iteration. |

The loop uses these knobs (edit them in `flow.ts`):

| Field | Default | Notes |
|---|---|---|
| `maxIterations` | `5` | Hard cap on body re-runs. Raise for harder tasks; lower to bound cost. |
| `until.from` | `review` | The body step whose handoff is inspected for the exit condition. |
| `until.when` | `{ decision: 'done' }` | Shallow-equality pattern matched against the `review` handoff. |

Models per step (override via `relay run {{pkgName}} --model.<step>=<model>`):

| Step | Kind | Default model |
|---|---|---|
| `implement` | `prompt` | `sonnet` |
| `feedback` | `ask` | n/a — pauses for human input, runs no model |
| `review` | `prompt` | `sonnet` |

## Customization

Fork the flow:

```bash
relay install {{pkgName}}
mv ./.relay/flows/{{pkgName}} ./my-fork
cd ./my-fork
```

Common customizations:

- **Tighten the review schema.** Edit `ReviewSchema` in `flow.ts` to add fields like `severity` or `categories`. Update the prompt in `prompts/02_review.md` to match.
- **Swap the model per step.** Set `model: 'opus'` on `implement` for harder reasoning, leave `review` on `sonnet` to keep cost low.
- **Add another body step.** For example, a `test` step between `feedback` and `review` that runs the project's test suite and feeds results into the review's context.
- **Drop the human-in-the-loop pause.** Remove the `feedback` step and reset `review.dependsOn` to `['implement']` and `review.contextFrom` to `['implementation']` for an unattended loop.
- **Ask more per iteration.** Add questions to `feedback.questions` — for example a `confirm` to halt the loop early, or a `select` for a category. Each question id becomes a field on the `feedback` handoff.
- **Change the exit condition.** `until.when` accepts any shallow-equality pattern — for example, `{ decision: 'done', confidence: 'high' }` if you add a `confidence` field to `ReviewSchema`.

## License

MIT. Copyright Ganderbite.
