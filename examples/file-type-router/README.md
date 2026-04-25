# file-type-router

`●─▶●─▶●─▶●  file-type-router`

A routing example. Use it to see how `step.branch()` inspects a condition, maps an exit code to a step id, and records the routing decision in the run state — the pattern most real flows use for dispatching on file kind, feature flag, or input shape.

## What it does

The flow looks at one file path and picks a review prompt that matches the file's extension:

- `.ts` files route to a TypeScript-specific code review.
- `.js` files route to a JavaScript-specific code review.
- Anything else routes to a generic plain-text analysis.

It exists to demonstrate one primitive: `step.branch()`. A branch step runs a short command, reads its exit code, and looks the exit code up in an `onExit` map to record which step id is the selected route. The branch step itself produces no artifact and no handoff — its only product is the routing decision.

The flow has four steps in total: one branch (`route`) and three leaf prompt steps (`reviewTypescript`, `reviewJavascript`, `analyzeText`). The `route` step's exit code identifies the selected branch and is written to `steps.route.exitCode` in the run state.

> Note: branch-step sibling skipping is not yet implemented in the Relay orchestrator. All three leaf steps run on every invocation; the branch step's exit code is captured in the run state (`steps.route.exitCode`) for reference. Once sibling skipping lands in a later sprint, the two un-selected leaves will be marked `skipped` and will not be dispatched. The flow remains useful today as a demonstration of the `step.branch()` primitive and its `onExit` contract.

## Prerequisites

- Node ≥ 20.10 and pnpm, same as the rest of the Relay monorepo.
- A working Claude subscription (Pro or Max). The three leaf prompts each run one short prompt.
- A file you want to review on your local disk. The flow reads its path from the `FILE_PATH` environment variable (for the branch step) and from the `--filePath` input variable (for the leaf prompts).

## Install

This flow ships inside the Relay monorepo as a local example. There is no published package. From a clone of the repo:

```bash
pnpm install
pnpm --filter @relay/example-file-type-router build
```

The build step compiles `flow.ts` to `dist/flow.js`, which is the artifact the CLI loads.

## Configure

This flow runs on your Claude subscription. Run `claude /login` once to authenticate before your first run.

Run `relay doctor` before your first run to confirm Node, the `claude` binary, auth state, and the `.relay` directory are all in order.

No per-step model overrides are set. The leaf prompts run on whichever model your provider picks by default.

## Run

Set `FILE_PATH` for the branch step, pass `--filePath` for the prompt steps, then run the flow:

```bash
FILE_PATH=./src/index.ts relay run /path/to/relay/examples/file-type-router --filePath=./src/index.ts
```

Two separate channels are required because they have different reachability:

- The `route` branch step is a subprocess that inherits the full parent env, so it reads `FILE_PATH` from the shell.
- The leaf prompt steps run through the claude-cli provider, which strips non-allowlisted env vars before subprocess launch. They read the path through Zod input substitution — `{{input.filePath}}` in each prompt template — which requires `--filePath` on the CLI.

The `route` step runs a short node one-liner that reads `FILE_PATH`, extracts the extension, and exits with code `0` for `.ts`, `1` for `.js`, or `2` for anything else. The step's `onExit` map translates that exit code into a step id:

```ts
route: step.branch({
  run: ['node', '-e', "... exit 0 for ts, 1 for js, 2 otherwise ..."],
  onExit: {
    '0': 'reviewTypescript',
    '1': 'reviewJavascript',
    '2': 'analyzeText',
    default: 'abort',
  },
});
```

The `default: 'abort'` entry makes the failure mode explicit: if the node one-liner itself crashes (a node runtime error exiting with an unmapped code), the branch step aborts the run rather than silently falling through.

### Reading the routing decision

While the flow runs, the `relay run` CLI shows a live step grid with one row per step (status symbol, step id, model, duration, tokens). The branch step appears first in the grid and succeeds once the node one-liner exits.

After the run, the routing decision is on disk in `.relay/runs/<runId>/state.json`:

- `steps.route.exitCode` — the numeric exit the node script returned (`0`, `1`, or `2`).
- `steps.route.next` — the step id the router chose (`reviewTypescript`, `reviewJavascript`, or `analyzeText`).

The selected leaf writes a `review.md` artifact into `.relay/runs/<runId>/artifacts/`. The file shape differs per branch — the two review prompts produce sectioned code reviews, and the fallback produces a short file analysis. Because branch-sibling skipping is not yet wired, the other two leaves also write their own `review.md` under their own artifact paths on each run; `steps.route.next` is the authoritative pointer to the primary result.

## Sample Output

For a `.ts` file, `artifacts/review.md` from the `reviewTypescript` leaf looks like:

```markdown
# TypeScript Review: orchestrator.ts

The file defines the orchestrator loop that dispatches steps, reads state, and
decides when a run ends.

## Types and inference

- L87 casts `result` as `unknown` before narrowing — consider a discriminated
  union on `kind` so the cast can be dropped.
- L142 returns `Promise<any>` implicitly; tightening the return type would let
  callers drop one layer of runtime checks.

## Strictness

- L210 dereferences `state.steps[id]` without guarding for `undefined` under
  `noUncheckedIndexedAccess`.

## Recommendations

- Replace the `as unknown` cast at L87 with a `kind` discriminant.
- Add a `undefined` guard at L210 and propagate a typed error.
```

For a non-code file, `artifacts/review.md` from the `analyzeText` leaf looks like:

```markdown
# File Analysis: README.md

A project README written in GitHub-flavored markdown; it introduces the tool
and lists install, run, and contribution instructions.

## Structure

- Seven top-level sections separated by `##` headings.
- 132 lines, roughly 4.8 KB.

## Observations

- Contains one mermaid diagram block.
- Links to `docs/billing-safety.md` for the auth contract.
```

The exact wording varies per run because the model generates it.

## Estimated cost and duration

- **Cost:** under $0.05 per run today. The branch step runs locally in node and costs nothing. All three leaf prompts currently dispatch on every run (see the orchestrator-gap note above), each reading the same file and producing a short review. On a Claude subscription the dollar figure is an API-equivalent estimate, not a charge on your account. Once sibling skipping lands, the per-run cost will drop to the single selected leaf.
- **Duration:** 1–3 minutes, dominated by model latency on the leaf prompts (which run in parallel). The branch step completes in well under a second.

## Configuration

The flow takes one Zod input variable and reads one environment variable.

| Name | Kind | Default | Notes |
|---|---|---|---|
| `filePath` | Zod input (`--filePath=...`) | (required) | Path to the file to review. Read by the three leaf prompt steps via `{{input.filePath}}` template substitution. |
| `FILE_PATH` | process env | (required) | Same path, passed to the `route` branch step's subprocess. The branch step cannot read Zod input variables — the `node -e` one-liner reads `process.env.FILE_PATH` at runtime. |

Both channels are required; set `FILE_PATH` in the shell environment and pass `--filePath` on the CLI to the same value. If `FILE_PATH` is empty or unset, the `route` step's extension match returns an empty string, which falls to exit code `2` — the `analyzeText` leaf becomes the selected route and produces a short analysis stating the file was missing or unreadable.

## Customization

Fork the flow by copying the directory:

```bash
cp -r examples/file-type-router ./my-router
cd ./my-router
```

Then edit:

- `flow.ts` — add more extensions to the router by extending the node one-liner and the `onExit` map. Every exit code you return must map to a step id, `'abort'`, or `'continue'`; unmapped non-zero exits without a `default` entry cause the branch step to fail the run.
- `prompts/review-typescript.md`, `prompts/review-javascript.md`, `prompts/analyze-text.md` — change the document shape, the sections, or the rules for what the review should cover.
- `package.json` — update the `name`, `description`, and the `relay` metadata block (especially `displayName` and `tags`).

To add a fourth branch (say, Python), add a new leaf step, add a new exit code to the node one-liner, and add the mapping to `onExit`:

```ts
run: ['node', '-e', "... exit 0 ts, 1 js, 3 py, 2 otherwise ..."],
onExit: {
  '0': 'reviewTypescript',
  '1': 'reviewJavascript',
  '2': 'analyzeText',
  '3': 'reviewPython',
  default: 'abort',
},
```

Rebuild with `pnpm --filter my-router build` after any change to `flow.ts`.

## License

MIT. Copyright Ganderbite.
