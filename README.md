<p align="center">
  <br>
  <code>●─▶●─▶●─▶●  relay</code>
  <br><br>
  <strong>Deterministic multi-step Claude flows.</strong>
  <br>
  Write the flow once. Run it the same way every time.
  <br><br>
</p>

## Why

If you delegate work to AI agents, you have probably hit these walls:

- The longer a turn ran, the worse the output got — the conversation window filled with chatter.
- You forgot to invoke the right subagent, and the main agent half-finished the work.
- You wrote the same prompt a dozen times over, changing one file path or argument each time.
- Compacting the conversation to free up room meant re-explaining the whole goal from scratch.
- The main agent skipped steps to keep its window from filling, and you only noticed downstream.
- The same prompt produced different answers on re-run.

Relay turns a multi-agent run into a typed, checkpointed graph:

- Each step gets a fresh conversation window of its own — no chatter accrues across steps.
- Subagent definitions live in the flow file. You can't forget to invoke one.
- Prompts are templated files. You write the shape once and pass variables in.
- Every step is checkpointed. A crash or `^C` resumes from the last completed step.
- Execution order is a DAG you can read, not a vibe the model decides.
- Relay can't make Claude deterministic. It can make the orchestration around Claude deterministic — same flow, same step order, same retries, same checkpoints.

## What it is

Relay ships as two packages.

- **`@ganderbite/relay`** — the `relay` CLI. Runs flows, resumes failed runs, scaffolds new flows, inspects auth.
- **`@ganderbite/relay-core`** — the TypeScript library. Compiles a flow spec into a validated DAG and executes it.

A flow is a directed acyclic graph of steps — `prompt`, `script`, `branch`, `parallel`, `loop`, `ask`, `terminal` — that pass typed JSON handoffs between them. The orchestrator persists a checkpoint after every step, so any run can resume from where it stopped with `relay resume <runId>`.

Relay runs on your Claude subscription (Pro / Max) via the local `claude` CLI. No API key, no surprise bills. See [docs/billing-safety.md](docs/billing-safety.md) for the auth contract.

## 60-second tour

```bash
npm install -g @ganderbite/relay
relay init                                 # configure your provider
relay doctor                               # check your environment
relay run codebase-discovery --repoPath=.  # produce a real artifact
```

`relay init` writes your provider choice to `~/.relay/settings.json`. Without it, the CLI exits with `NoProviderConfiguredError` before any step executes. `relay doctor` tells you whether your environment is safe to run.

`relay run codebase-discovery --repoPath=.` produces an HTML report describing this repo — about 12 minutes, about $0.40 of subscription budget (estimated API equivalent; billed to your subscription).

## What a flow looks like

```ts
import { defineFlow, step, z } from "@ganderbite/relay-core";

export default defineFlow({
  name: "hello",
  version: "0.1.0",
  input: z.object({ name: z.string() }),
  steps: {
    greet: step.prompt({
      promptFile: "prompts/01_greet.md",
      output: { handoff: "greeting" },
    }),
    summarize: step.prompt({
      promptFile: "prompts/02_summarize.md",
      dependsOn: ["greet"],
      contextFrom: ["greeting"],
      output: { artifact: "greeting.md" },
    }),
  },
});
```

A flow package is a directory containing `flow.ts`, a `prompts/` folder, and a `package.json`. The CLI runs it; the library compiles and executes it. The handlebars-style templating engine substitutes input fields and prior handoffs into the prompt files at step start.

For a walkthrough, see [docs/authoring-your-first-flow.md](docs/authoring-your-first-flow.md).

## What you get

- **DAG execution.** Steps run in topological order. Cycles and missing dependencies fail at `defineFlow()` time, before a single token is spent.
- **Checkpoint and resume.** Every step writes a checkpoint; `relay resume <runId>` continues a failed or aborted run from the last completed step.
- **Prompt templating.** Handlebars interpolation of the flow's input and prior handoffs into prompt files. Write the shape once.
- **Typed handoffs.** Zod schemas validate the JSON each step produces before the next step reads it. `HandoffSchemaError` exits with a distinct code so CI can route on it.
- **Subagent definitions.** Declare ephemeral subagents per step — name, system prompt, tools, model. Resolved before the provider is invoked.
- **Cost tracking.** Per-step tokens and dollar estimates persisted to `metrics.json` during the run.
- **Billing safety.** The CLI refuses to silently route tokens to a paid API account when subscription credentials are configured. See [docs/billing-safety.md](docs/billing-safety.md).
- **A testing path.** `@ganderbite/relay-core/testing` exports `MockProvider`, a zero-network, zero-cost provider for Vitest suites.

## Limitations

- **No `onStepStart` hook.** The `onStepComplete` callback fires after a step finishes. Hosts that need a dispatch signal must poll `state.json`.
- **No flow composition.** A flow cannot call another flow as a sub-flow. Multi-flow runs require separate `relay run` invocations or a host process that sequences them.

## Docs

- [Authoring Your First Flow](docs/authoring-your-first-flow.md) — step-by-step guide from scaffold to first run
- [Flow Package Format](docs/flow-package-format.md) — directory layout, package.json shape, step types, versioning
- [Resume Semantics](docs/resume-semantics.md) — how checkpoint, crash recovery, and `relay resume` work
- [Billing Safety](docs/billing-safety.md) — the API-key guard, opt-in paths, env allowlist, `relay doctor`
- [Env Containment](docs/flow-package-env-containment.md) — how Relay isolates subprocess environment variables
- [Naming Conventions](docs/naming-conventions.md) — vocabulary table, words to avoid, PR checklist
- [Troubleshooting](docs/troubleshooting.md) — common errors and remediation steps

## License

MIT — [full text](LICENSE)

Made by [Ganderbite](https://ganderbite.com). Dogfooded on my own codebase discovery and API-audit flows. Install with `npm install -g @ganderbite/relay`.
