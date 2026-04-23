# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

A Relay flow scaffolded from the `fan-out` template.

## What it does

Runs a fan-out / fan-in pipeline: one prep step produces shared context,
two analysis branches run concurrently against that context, and a final
merge step reconciles both branches into a single Markdown artifact. Use
this template when the two analyses are independent and can share the same
upstream inputs.

```
prep ──▶ branch_a ─┐
     │             ├──▶ merge
     └─▶ branch_b ─┘
```

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
  subscription on Pro/Max).
- **Duration:** ~3–10 minutes, depending on topic scope and model choice.

The two branch steps run in parallel, so the wall-clock time is roughly
`prep + max(branch_a, branch_b) + merge`.

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

The `topic` input is required and is echoed through the prep handoff into
both branches.

## Configuration

The flow accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `topic` | `string` | (required) | The subject both branches analyze. |

Models per step (override via `relay run . --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `prep` | provider default |
| `branch_a` | provider default |
| `branch_b` | provider default |
| `merge` | provider default |

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

## License

MIT.
