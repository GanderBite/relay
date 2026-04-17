<p align="center">
  <br>
  <code>●─▶●─▶●─▶●  relay</code>
  <br><br>
  <strong>Claude pipelines you can run twice.</strong>
  <br><br>
</p>

Deterministic orchestration. Crash-proof state. Transparent cost.
Runs on your Pro/Max subscription — no surprise API bills.

## 60-second tour

```bash
npm install -g @relay/cli
relay doctor                              # check your environment
relay run codebase-discovery .            # ship a real artifact
```

The first command tells you if you're safe to run. The second command
produces an HTML report describing this repo — in about 12 minutes,
for about $0.40 (estimated API equivalent; billed to your subscription).

## What is relay

relay is a TypeScript library and CLI for running multi-step Claude flows
that resume after crashes, never bill the API by surprise, and produce
the same artifact every time.

Each flow is a sequence of named steps. Each step runs a prompt, reads
a handoff from the previous step, and writes a handoff for the next.
State is saved after every step.

## Packages

| Package | Purpose |
|---|---|
| `@relay/core` | Library — `defineFlow`, `Runner`, `Provider`, step types |
| `@relay/cli` | CLI — `relay run`, `relay resume`, `relay doctor` |
| `@relay/generator` | Claude Code skill that scaffolds new flow packages |

## Primitives

```
flow        a named, versioned pipeline you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

## Requirements

- Node.js ≥ 25.8
- `claude` CLI installed and authenticated (Pro or Max subscription)
- pnpm ≥ 10 (for contributors)

## Status

Pre-release. Not yet published to npm.
