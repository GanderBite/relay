# onboarding-guide

`●─▶●─▶●─▶●  onboarding-guide`

## What it does

Scans a project directory and produces a day-one HTML onboarding guide tailored to a specific audience. Point it at any codebase, choose a role — `developer`, `pm`, `qa`, or `client` — and get a document covering setup, architecture, practices, and a prioritised day-one task checklist.

Four steps run in series:

```
scan               read README, CONTRIBUTING, manifests, CI files
   ↓
explore            map modules, bounded contexts, entry points, package dependencies
   ↓
extract-practices  git conventions, architecture, error handling, testing, local setup, gotchas
   ↓
write-guide        compose audience-specific sections + day-one checklist + glossary
   ↓
render             assemble self-contained HTML → guide.html (artifact)
```

## Estimated cost and duration

- **Cost:** $0.30–$1.20 per run (estimated API equivalent; billed to your subscription on Pro/Max).
- **Duration:** ~10–30 minutes, depending on repository size and audience complexity.

## Run

```bash
relay run . --projectDir=/path/to/repo --audience=developer
```

The guide is written to the run's artifact directory. The CLI prints the path on completion:

```
open the report    open ~/.relay/runs/<runId>/artifacts/guide.html
```

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `projectDir` | `string` | (required) | Absolute path to the project directory to document. |
| `audience` | `enum` | `developer` | One of `developer`, `pm`, `qa`, `client`. |

## Audience guide content

| Audience | Sections produced |
|---|---|
| `developer` | Local setup · Prerequisites · Architecture overview · Module map · Git conventions · Error handling · Testing · CI/CD · Gotchas · Where to contribute first |
| `pm` | Product overview · Key user flows · Data flow · Key constraints · Glossary |
| `qa` | Testing strategy · How to run tests · Coverage expectations · Required CI checks · Gotchas |
| `client` | What the product does · Key features · How to get access · Glossary |

Every audience gets a day-one task checklist and a glossary.

## Customization

Fork the flow:

```bash
relay install onboarding-guide
mv ./.relay/flows/onboarding-guide ./my-fork
cd ./my-fork
```

Common customizations:

- **Add an audience** — extend the `audience` enum in `flow.ts` and add a case in `prompts/04_write-guide.md`.
- **Change the section list** — edit the per-audience section instructions in `prompts/04_write-guide.md`.
- **Change the HTML layout** — edit `prompts/05_render.md`; the render step is prompt-driven so any structural change is a prompt edit.
- **Swap a model** — set `model: 'opus'` on a step in `flow.ts`. The `explore` and `extract-practices` steps benefit most from a stronger model on large codebases.

## License

MIT. Copyright Ganderbite.
