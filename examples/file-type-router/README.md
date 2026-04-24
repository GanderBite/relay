# file-type-router

`●─▶●─▶●─▶●  file-type-router`

A routing example. Use it to see how `step.branch()` inspects a condition, maps an exit code to a step id, and selects exactly one downstream step out of a fan — the pattern most real flows use for dispatching on file kind, feature flag, or input shape.

## What it does

The flow looks at one file path and picks a review prompt that matches the file's extension:

- `.ts` files go to a TypeScript-specific code review.
- `.js` files go to a JavaScript-specific code review.
- Anything else goes to a generic plain-text analysis.

It exists to demonstrate one primitive: `step.branch()`. A branch step runs a short command, reads its exit code, and looks the exit code up in an `onExit` map to decide which step runs next. There is no artifact, no handoff — the branch's only product is the routing decision.

The flow has four steps in total: one branch (`route`) and three leaf prompt steps (`reviewTypescript`, `reviewJavascript`, `analyzeText`). On any given run, exactly one leaf runs. The other two are not dispatched.

## Prerequisites

- Node ≥ 20.10 and pnpm, same as the rest of the Relay monorepo.
- A working Claude subscription (Pro or Max). The selected leaf runs one short prompt.
- A file you want to review on your local disk. The flow reads its path from the `FILE_PATH` environment variable.

## Install

This flow ships inside the Relay monorepo as a local example. There is no published package. From a clone of the repo:

```bash
pnpm install
pnpm --filter @relay/example-file-type-router build
```

The build step compiles `flow.ts` to `dist/flow.js`, which is the artifact the CLI loads.

## Configure

The flow runs on your Claude subscription. If `ANTHROPIC_API_KEY` is set in your environment, Relay refuses to start the run and prints a remediation message — unset the variable, pass `--api-key` to opt in explicitly, or set `RELAY_ALLOW_API_KEY=1`. See `docs/billing-safety.md` for the full auth precedence.

Run `relay doctor` before your first run to confirm Node, the `claude` binary, auth state, and the `.relay` directory are all in order.

No per-step model overrides are set. The selected leaf runs on whichever model your provider picks by default.

## Run

Set `FILE_PATH` to the file you want to review, then run the flow:

```bash
FILE_PATH=/abs/path/to/some/file.ts relay run /path/to/relay/examples/file-type-router
```

The `route` step is where the routing happens. It runs a short node one-liner that reads `FILE_PATH`, extracts the extension, and exits with code `0` for `.ts`, `1` for `.js`, or `2` for anything else. The step's `onExit` map translates that exit code into a step id:

```ts
route: step.branch({
  run: ['node', '-e', "... exit 0 for ts, 1 for js, 2 otherwise ..."],
  onExit: {
    '0': 'reviewTypescript',
    '1': 'reviewJavascript',
    '2': 'analyzeText',
  },
});
```

### Reading the selected branch in the live output

While the flow runs, the CLI prints one row per step in the step grid. The branch step appears first:

```
 ✓ route              script     0.1s    exit=0  →  reviewTypescript
 ⠋ reviewTypescript   sonnet     turn 2  0.6K→0.4K    ~.014
 ○ reviewJavascript   not selected
 ○ analyzeText        not selected
```

The `exit=<n>  →  <stepId>` tail on the branch row is how you read the decision the router made. The two un-selected leaves show `not selected` in the status column and never transition to running.

After the run, the same information is on disk in `.relay/runs/<runId>/state.json`:

- `steps.route.exitCode` — the numeric exit the node script returned.
- `steps.route.next` — the step id the router chose (`reviewTypescript`, `reviewJavascript`, or `analyzeText`).
- `steps.<leaf>.status` — `succeeded` on the chosen leaf; `skipped` on the others.

The selected leaf writes a `review.md` artifact into `.relay/runs/<runId>/artifacts/`. The file shape differs per branch — the two review prompts produce sectioned code reviews, and the fallback produces a short file analysis.

## Sample Output

For `FILE_PATH=./src/orchestrator.ts`, `artifacts/review.md` looks like:

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

For `FILE_PATH=./README.md`, the flow picks the fallback branch and produces:

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

- **Cost:** under $0.02 per run. The branch step runs locally in node and costs nothing. The selected leaf runs one short prompt against a single file, typically a few thousand tokens of input and under 500 tokens of output. On a Claude subscription the dollar figure is an API-equivalent estimate, not a charge on your account.
- **Duration:** 1–3 minutes, dominated by model latency on the one prompt that actually runs. The branch step completes in well under a second.

## Configuration

The flow's Zod input schema is empty — the file to review comes in through the environment instead, because branch-step commands cannot read input variables at runtime.

| Variable | Source | Default | Notes |
|---|---|---|---|
| `FILE_PATH` | process env | (required) | Absolute or relative path to the file to review. Read by the `route` branch step and by the selected leaf prompt. |

If `FILE_PATH` is empty or unset, the `route` step's extension match returns an empty string, which falls to exit code `2` — the `analyzeText` branch runs and produces a short analysis stating the file was missing.

## Customization

Fork the flow by copying the directory:

```bash
cp -r examples/file-type-router ./my-router
cd ./my-router
```

Then edit:

- `flow.ts` — add more extensions to the router by extending the node one-liner and the `onExit` map. Every exit code you return must map to a step id, `'abort'`, or `'continue'`; unmapped non-zero exits cause the branch step to fail the run.
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
},
```

Rebuild with `pnpm --filter my-router build` after any change to `flow.ts`.

## License

MIT. Copyright Ganderbite.
