# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

An iterative implement-review flow. One outer step (`fix_loop`) wraps two inner steps that run in sequence: `implement` makes a change, then `review` inspects it and decides `continue` or `done`. When `review` returns `decision: 'done'`, the loop exits. Otherwise the body re-runs — `implement` reads the prior `review.feedback` from its handoff and addresses each point. The loop caps at five iterations to bound cost; raise or lower the cap in `flow.ts` to fit your task.

Use this template when the work has a clear acceptance check (a test passes, a lint rule is clean, a refactor is structurally correct) and the model can make incremental progress between iterations.

## Sample output

The flow emits two handoffs per iteration: `implementation` (`{ summary, files[] }`) and `review` (`{ decision, feedback? }`). The final `review` handoff has `decision: 'done'`. Add a transcript or screenshot to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.10–$1.00 per run on the default sonnet model (billed to your subscription on Pro/Max). Cost scales linearly with the number of iterations.
- **Duration:** 5–30 minutes — one to five iterations of two prompts each.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --task="describe the change you want made"
```

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

| Step | Default model |
|---|---|
| `implement` | `sonnet` |
| `review` | `sonnet` |

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
- **Add a third body step.** For example, a `test` step between `implement` and `review` that runs the project's test suite and feeds results into the review's context.
- **Change the exit condition.** `until.when` accepts any shallow-equality pattern — for example, `{ decision: 'done', confidence: 'high' }` if you add a `confidence` field to `ReviewSchema`.

## License

MIT. Copyright Ganderbite.
