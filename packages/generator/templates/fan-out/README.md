# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

A Relay flow scaffolded from the `fan-out` template.

## What it does

Runs a fan-out / fan-in pipeline: an interactive `gather` step pauses the
run to ask the operator which angle the branches should focus on, two
analysis branches then run concurrently against that shared answer, and a
final merge step reconciles both branches into a single Markdown artifact.
Use this template when the two analyses are independent and can share the
same upstream context.

```
gather ──▶ branch_a ─┐
       │             ├──▶ merge
       └─▶ branch_b ─┘
```

The `gather` step is placed BEFORE the parallel barrier on purpose. Ask
steps inside parallel branches are forbidden because the orchestrator
cannot serialize answers from two simultaneous pauses — gather your inputs
upstream, then fan out.

## Sample output

After a successful run, the flow writes `merged.md` into the run directory
(`./.relay/runs/<id>/merged.md`). The file follows this structure:

```markdown
# <topic>

## Branch A: risks
- ...

## Branch B: opportunities
- ...

## Agreements
- ...

## Tensions
- ...

## Next steps
- ...
```

## Estimated cost and duration

- **Cost:** $0.05–$0.25 per run (estimated API equivalent; billed to your
  subscription on Pro/Max). The `gather` step itself is free — cost is
  driven by the two branch prompts and the merge.
- **Duration:** 1–10 minutes of model time, plus however long the operator
  takes to answer `gather`.

The two branch steps run in parallel, so the wall-clock model time is
roughly `max(branch_a, branch_b) + merge`.

## Install

This flow was scaffolded locally. To run it from its own directory:

```bash
relay run .
```

To install it from the catalog (once published):

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run . --topic="the subject to analyze"
```

The run will pause at `gather`. The CLI exits with code 75 and prints:

```
answer: relay answer <runId>
```

Provide the focusing angle to resume:

```bash
relay answer <runId>
```

Or pass the answer non-interactively:

```bash
relay answer <runId> --json '{"focus":"second-order risks"}'
```

The `topic` input is required and is read by both branch prompts alongside
the operator's `focus` answer.

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
| `topic` | `string` | (required) | The subject both branches analyze. |

The `gather` step asks these questions (edit the array in `flow.ts` to add
or remove questions):

| Question id | Kind | Label |
|---|---|---|
| `focus` | `text` | What angle should the branches focus on? |

Models per step (override via `relay run . --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `branch_a` | provider default |
| `branch_b` | provider default |
| `merge` | provider default |

`gather` does not invoke a model — it pauses the run and waits for
`relay answer`.

## Customization

The template ships with neutral branch framings (`risks` vs `opportunities`)
that you are expected to replace. Common edits:

- **Rename the branches.** Rename `branch_a` / `branch_b` in `flow.ts` and
  the matching prompt files to reflect the actual angles you want. Update
  the `branches` array inside `step.parallel` and the `contextFrom` array
  on the `merge` step to match.
- **Add a third branch.** Define `step.prompt` for `branch_c`, add it to
  `barrier.branches`, and reference its handoff in `merge`'s
  `contextFrom`. The orchestrator fans out as wide as the array.
- **Switch the merge artifact.** Change `output: { artifact: 'merged.md' }`
  on the merge step to `{ handoff: 'merged' }` if a downstream tool needs
  structured JSON rather than Markdown.
- **Tighten the schemas.** Attach a Zod schema to the handoffs in
  `output.schema` to fail fast if a branch returns malformed JSON.
- **Add or change ask questions.** Edit the `questions` array in `gather`.
  Use `select` or `multiselect` for closed-set inputs; `number` for ranges;
  `multiline` for longer prose. Keep the ask step BEFORE the barrier — never
  inside a branch.

## License

MIT.
