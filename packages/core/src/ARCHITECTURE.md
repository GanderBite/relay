# @ganderbite/relay-core — module map

`@ganderbite/relay-core` is the runtime library for Relay. It defines the DSL
authors use to declare a flow, compiles that into an executable dependency graph,
drives the DAG walk, manages per-step state and handoffs, and surfaces a typed
error hierarchy to the CLI. No user-facing output lives here.

---

## Read these first

| File | Why |
|---|---|
| `index.ts` | Public API — every type and function the CLI or a flow author imports. |
| `orchestrator/orchestrator.ts` | `Orchestrator` class; owns the run lifecycle from auth through result collection. |
| `flow/define.ts` | `defineFlow` — the DSL entry point every flow package calls. |
| `state.ts` | `StateMachine` — the checkpoint layer; read before touching run state. |

---

## Module map (dependency order)

**Foundation**

| Module | Description |
|---|---|
| `zod.ts` | Re-exports Zod v4 under the project alias; all `z` imports go through here. |
| `errors.ts` | `PipelineError` base class and every typed subclass with stable error codes. |
| `constants.ts` | Stable string constants (GitHub repo and issues URLs). |
| `logger.ts` | Thin pino wrapper producing structured JSON logs. |
| `util/atomic-write.ts` | `atomicWriteJson` — write-then-rename so readers never see a partial file. |
| `util/json.ts` | `parseWithSchema` — safe JSON parse with Zod validation, returns `Result`. |

**Flow DSL**

| Module | Description |
|---|---|
| `flow/types.ts` | Core type algebra: `Flow`, `Step` (discriminated union), `RunState`, `StepState`. |
| `flow/schemas.ts` | Zod schemas for `FlowSpec` input; validates the object passed to `defineFlow`. |
| `flow/step.ts` | `step` builder namespace — `step.prompt`, `step.script`, `step.branch`, etc. |
| `flow/question.ts` | `Question` type and schema for `ask` steps that pause for user input. |
| `flow/steps/prompt.ts` | Builder and type for `prompt` steps (LLM invocation). |
| `flow/steps/script.ts` | Builder and type for `script` steps (shell command). |
| `flow/steps/branch.ts` | Builder and type for `branch` steps (conditional routing). |
| `flow/steps/parallel.ts` | Builder and type for `parallel` steps (fan-out). |
| `flow/steps/loop.ts` | Builder and type for `loop` steps (bounded iteration). |
| `flow/steps/ask.ts` | Builder and type for `ask` steps (pause-for-input). |
| `flow/steps/terminal.ts` | Builder and type for `terminal` steps (interactive shell). |
| `flow/define.ts` | `defineFlow` — validates spec, resolves graph, returns a compiled `Flow`. |
| `flow/graph/compose.ts` | `buildGraph` — DAG construction entry point; delegates to sub-modules below. |
| `flow/graph/edges.ts` | Derives directed edges from `dependsOn` declarations. |
| `flow/graph/cycle.ts` | Detects cycles; fails fast at load time before any tokens are spent. |
| `flow/graph/roots.ts` | Identifies steps with no incoming edges (the initial ready set). |
| `flow/graph/producers.ts` | Maps each handoff name to the step that produces it. |
| `flow/graph/ancestors.ts` | Computes the full ancestor set for a given step node. |

**Runtime**

| Module | Description |
|---|---|
| `state.ts` | `StateMachine` — reads, transitions, and atomically writes `state.json` per run. |
| `handoffs.ts` | `HandoffStore` — reads and writes per-step handoff files with Zod validation. |
| `cost.ts` | `CostTracker` — accumulates token/dollar metrics; persists `metrics.json`. |
| `context-inject.ts` | `assemblePrompt` — loads handoff values and injects them into a prompt template. |

**Orchestrator**

| Module | Description |
|---|---|
| `orchestrator/orchestrator.ts` | `Orchestrator` — coordinates auth, bootstrap, DAG walk, and result collection. |
| `orchestrator/execute-run.ts` | Main run loop — iterates the ready queue until the graph is drained. |
| `orchestrator/dag-walk.ts` | Advances the DAG after each dispatch: ready → running → succeeded/failed. |
| `orchestrator/step-dispatch.ts` | Picks a step from the ready queue and routes it to the correct executor. |
| `orchestrator/step-kind-registry.ts` | `StepKindRegistry` — maps step kinds to `{synthesize, execute}` entries. |
| `orchestrator/step-registrations.ts` | Side-effect module that registers the seven built-in step kinds at startup. |
| `orchestrator/auth.ts` | `authenticateProviders` — runs provider auth probes and surfaces errors early. |
| `orchestrator/resume.ts` | `importFlow` and `seedReadyQueueForResume` — reconnects a crashed run to its state. |
| `orchestrator/run-bootstrap.ts` | Creates the run directory, writes `flow-ref.json`, seeds the handoff helper. |
| `orchestrator/run-options.ts` | `RunOptions`, `OrchestratorOptions`, `RunResult` — public orchestrator API types. |
| `orchestrator/retry.ts` | Retry policy — decides whether a failed step attempt should be retried. |
| `orchestrator/exec/prompt.ts` | Executor for `prompt` steps — invokes the provider and stores handoffs. |
| `orchestrator/exec/script.ts` | Executor for `script` steps — spawns a shell command with controlled env. |
| `orchestrator/exec/branch.ts` | Executor for `branch` steps — evaluates the condition and sets the active branch. |
| `orchestrator/exec/parallel.ts` | Executor for `parallel` steps — fans out and collects child results. |
| `orchestrator/exec/loop.ts` | Executor for `loop` steps — iterates until exit condition or limit. |

**Providers**

| Module | Description |
|---|---|
| `providers/types.ts` | `Provider` interface, `ProviderCapabilities`, and streaming event types. |
| `providers/registry.ts` | `ProviderRegistry` — registers and resolves providers by name. |
| `providers/claude-cli/provider.ts` | `ClaudeCliProvider` — runs `claude -p` as a subprocess; the default subscription-safe provider. |
| `providers/claude-cli/auth.ts` | Enforces the billing-safety guard: rejects `ANTHROPIC_API_KEY` for subscription users. |
| `providers/claude-cli/env.ts` | Constructs the allowed environment for the `claude` subprocess. |
| `providers/claude-cli/translate.ts` | Translates stream-json envelopes from `claude -p` into `InvocationEvent` values. |

**Settings and testing**

| Module | Description |
|---|---|
| `settings/schema.ts` | Zod schema for `settings.json`. |
| `settings/paths.ts` | `globalSettingsPath` and `flowSettingsPath` — canonical filesystem locations. |
| `settings/resolve.ts` | `resolveProvider` — three-tier lookup: CLI flag → flow settings → global settings. |
| `testing/mock-provider.ts` | `MockProvider` — deterministic in-process provider for Vitest tests; no subprocess. |

---

## Adding a new step kind

Add the builder in `flow/steps/<kind>.ts`, the executor in `orchestrator/exec/<kind>.ts`,
then call `registry.register({ kind, synthesize, execute })` in `orchestrator/step-registrations.ts`.
That single call wires synthesis and dispatch for the new kind across the entire runtime.

## Adding a new provider

1. Create `providers/<name>/provider.ts` implementing the `Provider` interface from `providers/types.ts`.
2. Register via `ProviderRegistry.register()` or pass through `OrchestratorOptions.providers`.
3. Export the class from `providers/index.ts`.
