# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

A Relay race scaffolded from the `fan-out` template.

## What it does

Runs a fan-out / fan-in pipeline: one prep runner produces shared context,
two analysis branches run concurrently against that context, and a final
merge runner reconciles both branches into a single Markdown artifact. Use
this template when the two analyses are independent and can share the same
upstream inputs.

```
prep ──▶ branch_a ─┐
     │             ├──▶ merge
     └─▶ branch_b ─┘
```

## Sample output

After a successful run, the race writes `merged.md` into the run directory
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

The two branch runners run in parallel, so the wall-clock time is roughly
`prep + max(branch_a, branch_b) + merge`.

## Install

This race was scaffolded locally. To run it from its own directory:

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

The `topic` input is required and is echoed through the prep baton into
both branches.

## Configuration

The race accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `topic` | `string` | (required) | The subject both branches analyze. |

Models per runner (override via `relay run . --model.<runner>=<model>`):

| Runner | Default model |
|---|---|
| `prep` | provider default |
| `branch_a` | provider default |
| `branch_b` | provider default |
| `merge` | provider default |

## Customization

The template ships with neutral branch framings (`risks` vs `opportunities`)
that you are expected to replace. Common edits:

- **Rename the branches.** Rename `branch_a` / `branch_b` in `race.ts` and
  the matching prompt files to reflect the actual angles you want. Update
  the `branches` array inside `runner.parallel` and the `contextFrom` array
  on the `merge` runner to match.
- **Add a third branch.** Define `runner.prompt` for `branch_c`, add it to
  `barrier.branches`, and reference its baton in `merge`'s
  `contextFrom`. The orchestrator fans out as wide as the array.
- **Switch the merge artifact.** Change `output: { artifact: 'merged.md' }`
  on the merge runner to `{ baton: 'merged' }` if a downstream tool needs
  structured JSON rather than Markdown.
- **Tighten the schemas.** Attach a Zod schema to the batons in
  `output.schema` to fail fast if a branch returns malformed JSON.

## License

MIT.
