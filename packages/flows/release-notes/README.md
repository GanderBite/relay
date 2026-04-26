# release-notes

`●─▶●─▶●─▶●  release-notes`

Takes a git ref range and produces three parallel release artifacts in one run: a developer changelog, a user-facing what's new document, and a marketing highlights brief. A final cross-check step verifies consistency across all three outputs.

## What it does

```
parse_commits ──▶ write_technical ─┐
              │                    │
              ├─▶ write_customer ──┼──▶ cross_check
              │                    │
              └─▶ write_marketing ─┘
```

**parse_commits** — runs `git log` between the two refs, parses each commit using the Conventional Commits format, and identifies breaking changes with migration notes.

The three branch steps run in parallel against the same parsed data:

- **write_technical** writes `changelog.md` for developers: breaking changes with migration notes, features, fixes, deps, and other changes grouped by type.
- **write_customer** writes `whats-new.md` for end users: plain-language descriptions of visible changes, no commit SHAs or technical jargon.
- **write_marketing** writes `highlights.md` for stakeholders: a headline, three to five top highlights, and a by-the-numbers summary.

**cross_check** reads all three outputs and verifies consistency: breaking changes coverage, claim accuracy across audiences, and count integrity.

## Sample output

After a run the flow directory contains four artifacts:

```
changelog.md       # grouped by Breaking / Features / Fixes / Deps / Other
whats-new.md       # plain-language for users
highlights.md      # headline + bullets for stakeholder comms
cross-check.md     # consistency verdict and discrepancy list
```

Add an excerpt to `examples/` after your first real run.

## Estimated cost and duration

- **Cost:** $0.10–$0.50 per run (billed to your subscription on Pro/Max).
- **Duration:** 5–15 minutes depending on commit volume and model choice.

## Install

```bash
relay install release-notes
```

## Run

```bash
relay run release-notes --fromRef=v1.2.0 --projectName="My App"
```

Generate only specific audiences:

```bash
relay run release-notes --fromRef=v1.2.0 --projectName="My App" --audiences='["technical","marketing"]'
```

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `fromRef` | `string` | (required) | Git tag or commit SHA to start from (exclusive). |
| `toRef` | `string` | `HEAD` | Git tag or commit SHA to end at (inclusive). |
| `projectName` | `string` | (required) | Project name used in the output documents. |
| `audiences` | `string[]` | all three | One or more of `technical`, `customer`, `marketing`. |

## Outputs

| Artifact | Step | Audience | Contents |
|---|---|---|---|
| `changelog.md` | `write_technical` | Developers | Grouped commits: breaking changes, features, fixes, deps, other |
| `whats-new.md` | `write_customer` | End users | Plain-language feature and fix descriptions |
| `highlights.md` | `write_marketing` | Stakeholders | Headline, top highlights, summary line |
| `cross-check.md` | `cross_check` | All | Consistency report across all three outputs |

## Customization

Fork this flow:

```bash
relay install release-notes
mv ./.relay/flows/release-notes ./my-release-notes
cd ./my-release-notes
```

Common customizations:

- **Swap the model** — add `model: 'opus'` to a step spec in `flow.ts` for higher-quality prose on one branch.
- **Add a fourth audience** — add a new `step.prompt` to `steps`, add it to `barrier.branches` and `cross_check.contextFrom`, and write a new prompt file.
- **Tighten the parsed data schema** — add a Zod schema to `schemas/commits.ts` and set `output.schema` on the `parse_commits` step.
- **Scope to a subdirectory** — add `-- <path>` to the git log command in `prompts/01_parse-commits.md`.

## License

MIT. Copyright Ganderbite.
