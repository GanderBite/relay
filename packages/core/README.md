# @relay/core

The TypeScript library that powers Relay. Defines flows, validates step DAGs,
manages run state, and invokes Claude through pluggable providers.

---

## What it does

`@relay/core` gives you two things: a compiler (`defineFlow`) that turns a typed
TypeScript object into a validated flow graph, and a `Runner` that executes that
graph with checkpoint/resume, cost tracking, and billing-safe provider dispatch.

Flows are directed acyclic graphs of steps. Each step is one of five kinds:
`prompt`, `script`, `branch`, `parallel`, or `terminal`. Steps pass data forward
as handoffs — typed JSON objects validated by Zod schemas. The orchestrator persists a
checkpoint after every step completes; a crashed run resumes from the last good
checkpoint with `relay resume <runId>`.

---

## Install

```bash
npm install @relay/core
```

Requires Node ≥ 20.10 and TypeScript 5.4+ (`"module": "NodeNext"` in tsconfig).

---

## Quick start

```ts
import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'hello-world',
  version: '0.1.0',
  description: 'A minimal flow with one prompt step.',
  input: z.object({ topic: z.string() }),
  steps: {
    write: step.prompt({
      promptFile: 'prompts/01_write.md',
      output: { artifact: 'output.md' },
    }),
  },
});
```

Point the CLI at the compiled output:

```bash
relay run ./hello-world --topic="relay flows"
```

---

## Core API

### `defineFlow(spec)`

Compiles a flow spec into a validated `Flow` object. Throws `FlowDefinitionError`
synchronously if the spec is invalid — cycles, missing dependencies, bad schemas.
Import this once at module load; do not call it inside a function.

### `step.prompt(config)` / `step.script(config)` / `step.branch(config)` / `step.parallel(config)` / `step.terminal(config)`

The five step constructors. Each validates its config and throws `FlowDefinitionError`
on bad input. Prompt steps run in a contained subprocess with an explicit env
allowlist. Script and branch steps receive the full parent env — see
`docs/billing-safety.md` for the containment boundary.

### `Runner`

Executes a flow given input. Returns a `Result<RunSummary, RunError>`.

```ts
import { Runner } from '@relay/core';

const runner = new Runner({ runDir: '.relay/runs' });
const result = await runner.run(flow, { topic: 'relay flows' }, { flowDir, flowPath });
```

Call `runner.allowApiKey()` before `run()` to opt in to `ANTHROPIC_API_KEY` billing.

---

## Glossary

```
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

---

## License

MIT. Copyright Ganderbite.
