# @relay/core

The TypeScript library that powers Relay. Defines races, validates runner DAGs,
manages run state, and invokes Claude through pluggable providers.

---

## What it does

`@relay/core` gives you two things: a compiler (`defineRace`) that turns a typed
TypeScript object into a validated race graph, and a `Runner` that executes that
graph with checkpoint/resume, cost tracking, and billing-safe provider dispatch.

Races are directed acyclic graphs of runners. Each runner is one of five kinds:
`prompt`, `script`, `branch`, `parallel`, or `terminal`. Runners pass data forward
as batons — typed JSON objects validated by Zod schemas. The runner persists a
checkpoint after every runner completes; a crashed run resumes from the last good
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
import { defineRace, runner, z } from '@relay/core';

export default defineRace({
  name: 'hello-world',
  version: '0.1.0',
  description: 'A minimal race with one prompt runner.',
  input: z.object({ topic: z.string() }),
  runners: {
    write: runner.prompt({
      promptFile: 'prompts/01_write.md',
      output: { artifact: 'output.md' },
    }),
  },
});
```

Point the CLI at the compiled output:

```bash
relay run ./hello-world --topic="relay races"
```

---

## Core API

### `defineRace(spec)`

Compiles a race spec into a validated `Race` object. Throws `RaceDefinitionError`
synchronously if the spec is invalid — cycles, missing dependencies, bad schemas.
Import this once at module load; do not call it inside a function.

### `runner.prompt(config)` / `runner.script(config)` / `runner.branch(config)` / `runner.parallel(config)` / `runner.terminal(config)`

The five runner constructors. Each validates its config and throws `RaceDefinitionError`
on bad input. Prompt runners run in a contained subprocess with an explicit env
allowlist. Script and branch runners receive the full parent env — see
`docs/billing-safety.md` for the containment boundary.

### `Runner`

Executes a race given input. Returns a `Result<RunSummary, RunError>`.

```ts
import { Runner } from '@relay/core';

const runner = new Runner({ runDir: '.relay/runs' });
const result = await runner.run(race, { topic: 'relay races' }, { raceDir, racePath });
```

Call `runner.allowApiKey()` before `run()` to opt in to `ANTHROPIC_API_KEY` billing.

---

## Glossary

```
race        a named, versioned pipeline you can run
runner      one node in a race (prompt, script, branch, parallel)
baton       the JSON one runner produces and a later runner consumes
run         one execution of a race; identified by a run id
checkpoint  the saved state of a run after each runner completes
```

---

## License

MIT. Copyright Ganderbite.
