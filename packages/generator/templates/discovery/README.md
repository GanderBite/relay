# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

Reads a repository and produces a six-section HTML report describing the
packages, entities, and runtime services inside it. Written for product
managers and developers who have just inherited the codebase and need a
map of it. Four steps, about five to twenty minutes per run, under one
US dollar of estimated API-equivalent cost — billed to your Pro/Max
subscription.

## Sample output

[Sample report (HTML)](./examples/sample-output.html)

## Estimated cost and duration

- **Cost:** $0.20–$0.80 per run (estimated API equivalent; billed to
  your subscription if you are on Pro/Max).
- **Duration:** ~5–20 minutes, depending on repository size.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} <repo-path> [--audience=pm|dev|both]
```

The most common invocation, pointing the race at the current directory:

```bash
relay run {{pkgName}} .
```

## Configuration

The race accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `repoPath` | `string` | (required) | Absolute path to the repository. |
| `audience` | `enum` | `both` | One of `pm`, `dev`, `both`. Tunes the report prose. |

The race runs four runners: `inventory`, then `entities` and `services`
in parallel, then `report`. Each runner uses the default provider
(`sonnet` when Claude is installed).

## Customization

Fork the race:

```bash
relay install {{pkgName}}
mv ./.relay/races/{{pkgName}} ./my-discovery
cd ./my-discovery
relay run .
```

Common customizations:

- **Tighten the schema.** Edit `schemas/inventory.ts` or
  `schemas/entities.ts` to require or optionalize fields.
- **Swap the model.** Pass `--model.report=opus` on the command line,
  or edit `race.ts` to set `model` per runner.
- **Change the report layout.** Edit `prompts/04_report.md`. The
  section list at the top of the prompt controls what ships.

## License

MIT. Copyright Ganderbite.
