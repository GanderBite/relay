# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

A two-step interactive flow. The first step (`gather`) is an `ask` step — when the run reaches it, the orchestrator pauses, persists state, and exits. The operator then runs `relay answer <runId>` to provide values for each question; that command writes the answers and resumes the run. The second step (`execute`) is a prompt step that reads the published answer handoff and produces a result.

Use this template when the work cannot start until a human supplies a goal, an approval, or a parameter that the prior steps could not produce on their own.

## Sample output

`gather` publishes its answers as a handoff named `gather` (the ask step's id is the canonical handoff name for its answer map). `execute` reads that handoff plus `input.topic` and emits a `result` handoff with shape `{ result: string }`. Add a transcript or screenshot to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.01–$0.20 per run on the default sonnet model (billed to your subscription on Pro/Max). Cost is dominated by the `execute` prompt — `gather` itself is free.
- **Duration:** 1–10 minutes — most of which is the operator answering the questions.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --topic="your topic here"
```

The run will pause at `gather`. The CLI exits with code 75 and prints:

```
answer: relay answer <runId>
```

Provide the answers to resume:

```bash
relay answer <runId>
```

Or pass them non-interactively:

```bash
relay answer <runId> --json '{"goal":"draft a release note","confirm":true}'
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
| `topic` | `string` | (required) | A short topic the run is about. The `execute` prompt reads it verbatim. |

The `gather` step asks these questions (edit the array in `flow.ts` to add or remove questions):

| Question id | Kind | Label |
|---|---|---|
| `goal` | `text` | What is the goal of this run? |
| `confirm` | `confirm` | Proceed with the above goal? |

Question kinds available on `step.ask`: `text`, `multiline`, `select`, `multiselect`, `confirm`, `number`. Each kind has its own option fields — see the `Question` type exported from `@ganderbite/relay-core`.

Models per step (override via `relay run {{pkgName}} --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `execute` | `sonnet` |

`gather` does not invoke a model — it pauses the run and waits for `relay answer`.

## Customization

Fork the flow:

```bash
relay install {{pkgName}}
mv ./.relay/flows/{{pkgName}} ./my-fork
cd ./my-fork
```

Common customizations:

- **Add or change questions.** Edit the `questions` array in the `gather` step. Use `select` or `multiselect` for closed-set inputs; `number` for ranges; `multiline` for longer prose.
- **Validate answers with a schema.** Pass `output: { schema: AnswerSchema }` on the `gather` step to reject malformed answer maps before the next step runs.
- **Source questions dynamically.** Replace `questions: [...]` with `questions: { from: 'priorStepHandoff' }` to read the question list from an upstream step's handoff. The handoff value must be an array of `Question` objects.
- **Add more downstream steps.** Each one can include `gather` in its `contextFrom` to read the operator's answers.

## License

MIT. Copyright Ganderbite.
