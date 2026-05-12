# @ganderbite/relay-core

The TypeScript library that powers Relay. Defines flows, validates step DAGs,
manages run state, and invokes Claude through pluggable providers.

---

## What it does

`@ganderbite/relay-core` gives you two things: a compiler (`defineFlow`) that turns a typed
TypeScript object into a validated flow graph, and an `Orchestrator` that executes
that graph with checkpoint/resume, cost tracking, and billing-safe provider dispatch.

Flows are directed acyclic graphs of steps. Each step is one of five kinds:
`prompt`, `script`, `branch`, `parallel`, or `terminal`. Steps pass data forward
as handoffs — typed JSON objects validated by Zod schemas. The orchestrator persists a
checkpoint after every step completes; a crashed run resumes from the last good
checkpoint with `relay resume <runId>`.

---

## Install

```bash
npm install @ganderbite/relay-core
```

Requires Node ≥ 20.10 and TypeScript 5.4+ (`"module": "NodeNext"` in tsconfig).

---

## Quick start

```ts
import { defineFlow, step, z } from '@ganderbite/relay-core';

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

#### Dynamic subagents

A prompt step accepts an optional `agents` field that defines ephemeral subagents
available for that invocation via Claude Code's Task tool. The definitions are
resolved at step-start time, before any provider cost is incurred.

**Inline array**

```ts
step.prompt({
  promptFile: 'prompts/implement.md',
  agents: [
    {
      name: 'code-reviewer',
      description: 'Reviews code for quality and security.',
      systemPrompt: 'You are a senior code reviewer.',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku',
    },
  ],
  output: { artifact: 'implementation.ts' },
})
```

**Dynamic from handoff**

```ts
step.prompt({
  promptFile: 'prompts/execute.md',
  agents: { from: 'handoff.execution_plan', required: true },
  output: { handoff: 'result' },
})
```

The `from` value follows the same prefix semantics as script `env` values:
`'handoff.<id>.<dot.path>'` reads a nested path from a prior step's handoff;
`'input.<dot.path>'` reads from the flow's input object.

**`AgentDefinition` fields**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique name for this agent within the step. Required. |
| `extends` | `string` | Name of a file in `.claude/agents/` to inherit from. Optional. |
| `description` | `string` | Short description visible to the parent Claude invocation. Optional. |
| `model` | `string` | Model alias for this agent (e.g. `'haiku'`, `'sonnet'`). Optional. |
| `tools` | `string[]` | Tool names the agent may use. Optional. |
| `skills` | `string[]` | Skill names to attach. Optional. |
| `systemPrompt` | `string` | System prompt for this agent. Optional. |
| `skillsMerge` | `'replace' \| 'append'` | Whether inherited skills are replaced or extended. Optional. |

**`extends` field**

Set `extends` to the name of a file in `.claude/agents/` (without extension) to
inherit that base agent's system prompt, tools, and skills. Any fields supplied
inline override the inherited values. `skillsMerge: 'append'` merges the
inherited skills list with the inline one; the default `'replace'` substitutes it.

**v1 constraint**

v1 supports either an inline array or a handoff reference — not both at the same
time. Setting `agents` to an array and relying on a handoff for additional
definitions in the same step is not supported.

**Failure modes**

`AgentsResolutionError` is thrown before any provider invocation when the agents
resolver cannot build a valid agent set. The `reason` field on the error details
discriminates the five failure modes:

| `reason` | Trigger |
|---|---|
| `handoff-shape-invalid` | A handoff's value exists but does not match the expected agent-definition array shape. |
| `extends-not-found` | An agent definition's `extends` field names a base agent file that cannot be located in `.claude/agents/`. |
| `duplicate-name` | Two or more agent definitions in the resolved set share the same `name`. |
| `handoff-missing` | The handoff referenced by `agents.from` is absent from the store and `required` is `true`. |
| `frontmatter-parse-error` | The YAML or JSON frontmatter in the referenced agent file could not be parsed. |

---

### `createOrchestrator(options?)` / `Orchestrator`

Executes a flow given input. Returns a `RunResult` with status, cost, artifacts,
and duration.

```ts
import { createOrchestrator } from '@ganderbite/relay-core';

const orchestrator = createOrchestrator({ runDir: '.relay/runs' });
const result = await orchestrator.run(flow, { topic: 'relay flows' }, { flowDir, flowPath });
```

`OrchestratorOptions` accepts `providers` (a `ProviderRegistry`), `runDir`, and
`logger`. Provider selection follows the three-tier order: `flagProvider` passed
to `run()`, then the flow's `settings.json`, then `~/.relay/settings.json`.

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

## Testing your flow

`@ganderbite/relay-core/testing` exports `MockProvider`, a zero-network, zero-cost provider
you can drop into any Vitest suite. You describe exactly what each step should
return; the provider replays those responses without spawning a subprocess or
reaching the Anthropic API.

Import path:

```ts
import { MockProvider } from '@ganderbite/relay-core/testing';
```

### Minimal working example

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrchestrator, defineFlow, ProviderRegistry, step, z } from '@ganderbite/relay-core';
import type { InvocationResponse } from '@ganderbite/relay-core';
import { MockProvider } from '@ganderbite/relay-core/testing';

const canned: InvocationResponse = {
  text: '{}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  durationMs: 0,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const flow = defineFlow({
  name: 'hello',
  version: '0.1.0',
  input: z.object({}),
  steps: {
    greet: step.prompt({ promptFile: 'prompts/greet.md', output: { handoff: 'greet-out' } }),
  },
});

describe('hello flow', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-test-'));
    await writeFile(join(tmp, 'prompts/greet.md'), '# greet', 'utf8');
  });

  afterEach(() => rm(tmp, { recursive: true, force: true }));

  it('runs the greet step and succeeds', async () => {
    const provider = new MockProvider({ responses: { greet: canned } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(flow, {}, { flowDir: tmp, flagProvider: 'mock' });

    expect(result.status).toBe('succeeded');
  });
});
```

### Scripting a multi-step exchange

Pass one keyed response per step name. Each value can be a plain
`InvocationResponse` or a function that receives the `InvocationRequest` and
`InvocationContext` — useful when you want to capture what the orchestrator
actually sent to the step, or to vary the response based on context.

```ts
const provider = new MockProvider({
  responses: {
    inventory: (_req, _ctx) => ({
      ...canned,
      text: JSON.stringify({ files: 42 }),
    }),
    summarise: (req, ctx) => {
      // req.prompt contains the rendered prompt string
      // ctx.stepId === 'summarise', ctx.attempt === 1
      return { ...canned, text: 'summary complete' };
    },
  },
});
```

If a step runs but no key is found for its `stepId`, the provider returns
`err(StepFailureError)` — the run records that step as failed, not silently
skipped. That makes unscripted steps a test error rather than a silent gap.

---

## License

MIT. Copyright Ganderbite.
