# spec-generator

`●─▶●─▶●─▶●  spec-generator`

## What it does

Takes a plain-language feature description and produces a structured Markdown specification. Four steps build on each other: `analyze` extracts actors and behaviors, `expand-requirements` generates FRs, NFRs, edge cases, validation rules, error handling, and authorization requirements, `derive-criteria` writes Given/When/Then acceptance criteria for each FR, and `write-spec` assembles the final document.

## Sample output

The flow writes `feature-spec.md` to the run directory. The document follows this structure:

```
# <feature-name> Feature Specification

## Summary
...

## Functional Requirements
1. <FR-001> ...

## Non-Functional Requirements
- <NFR-001> ...

## Edge Cases
- <EC-001> ...

## Validation Rules
- <VR-001> ...

## Error Handling
- <EH-001> <scenario>: <response>

## Authorization
- <AUTH-001> ...

## Acceptance Criteria
- [ ] <AC-001> Given ..., when ..., then ...
```

## Estimated cost and duration

- **Cost:** $0.05–$0.30 per run (billed to your subscription on Pro/Max).
- **Duration:** 2–10 minutes depending on feature complexity and model choice.

## Install

```bash
relay install spec-generator
```

## Run

```bash
relay run spec-generator --featureDescription="Users can reset their password via a link sent to their registered email address"
```

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `featureDescription` | `string` | (required) | Plain-language description of the feature to specify. |

Models per step (override via `relay run spec-generator --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `analyze` | `sonnet` |
| `expand-requirements` | `sonnet` |
| `derive-criteria` | `sonnet` |
| `write-spec` | `sonnet` |

## Customization

Fork the flow:

```bash
relay install spec-generator
mv ./.relay/flows/spec-generator ./my-spec-generator
cd ./my-spec-generator
```

Common customizations:

- **Add a section** — extend `schemas/requirements.ts` and update `prompts/02_expand-requirements.md` and `prompts/04_write-spec.md`.
- **Upgrade a step for higher quality** — set `model: 'opus'` on `expand-requirements` or `derive-criteria` in `flow.ts`.
- **Enforce minimum counts** — add `.min(3)` to arrays in `schemas/requirements.ts` so the validator rejects thin specs.
- **Rename the output file** — change the `artifact` value on `write-spec` in `flow.ts` to match your naming convention.

## License

MIT. Copyright Ganderbite.
