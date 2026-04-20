# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

A three-step linear flow: `{{stepNames[0]}}` runs first, then `{{stepNames[1]}}` reads its handoff, then `{{stepNames[2]}}` reads the second step's handoff and produces the final result. Edit the prompts in `prompts/` and the input schema in `flow.ts` to adapt the flow to your task.

## Sample output

Each step emits a JSON handoff with a `result` field. The final handoff is named `{{stepNames[2]}}` and its shape matches the last prompt's contract. Add a screenshot or transcript excerpt to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.05–$0.30 per run on the default sonnet model (billed to your subscription on Pro/Max).
- **Duration:** 2–10 minutes depending on prompt length and model choice.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --subject="your subject here"
```

## Configuration

The flow accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `subject` | `string` | (required) | The subject the flow operates on. |

Models per step (override via `relay run {{pkgName}} --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `{{stepNames[0]}}` | `sonnet` |
| `{{stepNames[1]}}` | `sonnet` |
| `{{stepNames[2]}}` | `sonnet` |

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
- **Add a fourth step** — copy one of the existing steps, wire `dependsOn` and `contextFrom` to the prior step's handoff name.

## License

MIT. Copyright Ganderbite.
