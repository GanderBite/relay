# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

A three-step linear flow that starts with a pause for human input. The first step (`gather`) is an `ask` step — when the run reaches it, the orchestrator pauses, persists state, and exits. The operator then runs `relay answer <runId>` to provide a goal; that command writes the answers and resumes the run. `{{stepNames[0]}}` reads the gathered answers and produces a handoff. `{{stepNames[1]}}` reads that handoff and produces the final result. Edit the prompts in `prompts/`, the question list in `flow.ts`, and the input schema to adapt the flow to your task.

## Sample output

`gather` publishes its answers as a handoff named `gather` (the ask step's id is the canonical handoff name for its answer map). Each prompt step then emits a JSON handoff with a `result` field. The final handoff is named `{{stepNames[1]}}` and its shape matches the second prompt's contract. Add a screenshot or transcript excerpt to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.05–$0.30 per run on the default sonnet model (billed to your subscription on Pro/Max). `gather` itself is free — cost is dominated by the two prompt steps.
- **Duration:** 2–10 minutes depending on prompt length and model choice, plus the time the operator takes to answer.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --subject="your subject here"
```

### Pause and answer

The run pauses at `gather`. The CLI exits with code 75 and prints:

```
answer: relay answer <runId>
```

Provide the answer to resume:

```bash
relay answer <runId>
```

Or pass it non-interactively:

```bash
relay answer <runId> --json '{"goal":"draft a release note"}'
```

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
| `subject` | `string` | (required) | The subject the flow operates on. |

The `gather` step asks these questions (edit the array in `flow.ts` to add or remove questions):

| Question id | Kind | Label |
|---|---|---|
| `goal` | `text` | What is the goal for this run? |

Models per step (override via `relay run {{pkgName}} --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `{{stepNames[0]}}` | `sonnet` |
| `{{stepNames[1]}}` | `sonnet` |

`gather` does not invoke a model — it pauses the run and waits for `relay answer`.

## Customization

Fork the flow:

```bash
relay install {{pkgName}}
mv ./.relay/flows/{{pkgName}} ./my-fork
cd ./my-fork
```

Then edit `prompts/`, `flow.ts`, or add schemas under `schemas/`. Common customizations:

- **Swap the model** — set `model: 'opus'` on a step in `flow.ts`.
- **Tighten each handoff** — add a Zod schema under `schemas/` and pass it via `output.schema` on each step.
- **Add or change questions.** Edit the `questions` array in the `gather` step. Question kinds available on `step.ask`: `text`, `multiline`, `select`, `multiselect`, `confirm`, `number`.
- **Add a fourth step** — copy one of the existing prompt steps, wire `dependsOn` and `contextFrom` to the prior step's handoff name.

## License

MIT. Copyright Ganderbite.
