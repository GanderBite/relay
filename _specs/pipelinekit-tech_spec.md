# PipelineKit — Technical Specification

**Status:** Draft v1
**Date:** 2026-04-17
**Owner:** Ganderbite
**Scope:** Prompt-based pipelines only. Skill-based flavor is explicitly out of scope.

---

## 0. Reading Guide

This document is the source-of-truth spec for three coordinated packages that together make up PipelineKit. It is structured so each section can be assigned as an independent body of work:

- §1–§3: shared context (read these first; everyone needs them).
- §4: `@pipelinekit/core` — the library.
- §5: `@pipelinekit/cli` — the runner and installer.
- §6: `@pipelinekit/generator` — the Claude Code skill.
- §7: the Flow Package format — the contract that ties §4–§6 together.
- §8: cross-cutting concerns (auth, errors, telemetry).
- §9: milestones and acceptance criteria.
- §10: open questions and explicit non-goals.

If you only ship one section, ship §4 — nothing else works without it.

---

## 1. Background and Motivation

Two prior documents establish the product context and should be read first:

- `pipeline_scaffolder_review.md` — the original idea validation that shifted from "advisor picks the mode" to "ship two explicit commands."
- `pipeline_scaffolder_pivot1_deep_dive.md` — the three-layer architecture (library + catalog + internal generator) that this spec now implements.

The Python prototype `monolith` (located at `~/projekty/ganderbite/monolith/monolith/`) is the reference implementation we are porting patterns from — manifest-driven flow execution, deterministic step routing, parallel agent batches, structured handoffs, and stream-json cost tracking. **PipelineKit is a TypeScript reinterpretation of those patterns, not a line-for-line port.** Several monolith capabilities are explicitly dropped (see §10.2).

### 1.1 Why TypeScript

The Ganderbite team is more productive in TypeScript than Python. TS also gives us a typed flow DSL — flows defined as `.ts` files get IDE autocomplete, refactor safety, and compile-time validation that step `inputs` reference real prior step `outputs`. YAML cannot offer this. The trade-off is that non-developers cannot easily edit a flow definition; that audience consumes flows through the CLI (`pipelinekit run <flow>`), which is type-agnostic.

### 1.2 Three-Tool System

| Tool | Package | Audience | Purpose |
|---|---|---|---|
| **AI pipeline library** | `@pipelinekit/core` | Flow authors | Primitives for defining and running pipelines: state machine, runner, orchestrator, handoff helpers. |
| **AI pipeline generator** | `@pipelinekit/generator` | Internal team (and later, power users) | A Claude Code skill that scaffolds new flows that use `@pipelinekit/core`. Internal factory tool — not a user-facing product. |
| **AI pipeline repository / CLI** | `@pipelinekit/cli` | End users (devs, PMs, ops) | `npx @pipelinekit/cli <flow> <input>` — installs and runs catalog flows. The user-facing surface. |

The catalog of flows itself (`@ganderbite/flows-*`) is downstream of this spec; it depends on these three packages but is not specified here.

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. **Deterministic orchestration.** A flow's control flow lives in TypeScript code we wrote, not in a model's autonomous decisions. Steps run when, where, and in the order we specify.
2. **Subscription-friendly by default.** The library MUST be runnable by anyone with a Claude Pro/Max subscription with no additional API charges. This is a hard product requirement (see §8.1).
3. **Library-first, framework-never.** `@pipelinekit/core` is a library users import and call. There is no runtime users must inherit from, no plugin lifecycle, no DI container. A flow file is a small, readable program that uses our primitives.
4. **Flows are portable artifacts.** A flow is a self-contained directory that can be installed, versioned, forked, and run independently. The catalog model from the deep-dive depends on this.
5. **Bulletproof state.** Pipelines crash. Networks blip. The state machine MUST allow resuming a partially-completed flow without redoing successful work.
6. **Observable by default.** Every prompt invocation logs tokens, cost, duration, and turn count. Users do not need to opt in to know what their flow cost.

### 2.2 Non-Goals (v1)

- **No skill-based pipelines.** Excluded by user direction. The library will not generate or manage Claude Code SKILL.md packages.
- **No interactive / human-in-the-loop steps.** No exit-code-10 dance, no `AskUserQuestion` integration, no inline CLI prompts mid-flow. Prompt-based flows are headless. Approval gates, if needed, become pre/post-flow scripts.
- **No visual builder, no GUI, no web UI.** Terminal and code only.
- **No multi-tenant SaaS, no hosted runner.** Possibly later; not v1.
- **No runtime brain memory.** The "brain" concept from monolith stays in monolith for now (it's bound up with the skill-based interactive flavor). Prompt-based flows pass context via JSON handoffs only.
- **No DAG planner / wave loop.** Monolith's `wave_loop` step type computes a task DAG and executes it dynamically. Out of scope for v1; flows are a static graph of named steps.
- **No parallel flows scheduling across machines.** Within-process parallelism (`Promise.all`) only.

---

## 3. System Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│ Layer 3 — Flow Catalog (downstream, not in this spec)             │
│   @ganderbite/flow-codebase-discovery                             │
│   @ganderbite/flow-api-audit                                      │
│   @ganderbite/flow-migration-planner                              │
│   ...                                                              │
└───────────────────────────────────────────────────────────────────┘
                            ▲ depends on
                            │
┌───────────────────────────────────────────────────────────────────┐
│ Layer 2 — User-facing tools                                       │
│                                                                    │
│   ┌──────────────────────┐         ┌────────────────────────┐    │
│   │ @pipelinekit/cli     │         │ @pipelinekit/generator │    │
│   │ - npx entry point    │         │ - Claude Code skill    │    │
│   │ - install / run      │         │ - generates flows      │    │
│   │ - flow registry      │         │   that use /core       │    │
│   └──────────────────────┘         └────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
                            ▲ depends on
                            │
┌───────────────────────────────────────────────────────────────────┐
│ Layer 1 — @pipelinekit/core                                       │
│   defineFlow(), Step types, Runner (orchestrator), StateMachine,  │
│   Handoff, ContextInjector, Logger, CostTracker,                  │
│   Provider interface + ProviderRegistry                           │
└───────────────────────────────────────────────────────────────────┘
                            ▲ Provider interface
                            │ (pluggable)
        ┌───────────────────┼─────────────────────┐
        │                   │                     │
┌───────────────┐  ┌────────────────┐   ┌──────────────────┐
│ ClaudeProvider│  │ OpenAIProvider │   │ ...future...     │
│ (ships v1)    │  │ (future)       │   │ Gemini, Bedrock, │
│               │  │                │   │ Ollama, mocks    │
└───────┬───────┘  └────────────────┘   └──────────────────┘
        │ wraps
        ▼
┌─────────────────────┐
│ @anthropic-ai/      │
│ claude-agent-sdk    │
│ (→ claude binary)   │
└─────────────────────┘
```

### 3.1 Repository Layout

A single pnpm/npm workspace monorepo:

```
pipelinekit/
├── package.json                # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/                   # @pipelinekit/core
│   │   ├── src/
│   │   ├── tests/
│   │   └── package.json
│   ├── cli/                    # @pipelinekit/cli
│   │   ├── src/
│   │   ├── bin/
│   │   ├── tests/
│   │   └── package.json
│   └── generator/              # @pipelinekit/generator
│       ├── skill/              # SKILL.md + assets shipped to .claude/skills/
│       ├── templates/          # flow scaffolding templates
│       └── package.json
└── examples/
    ├── codebase-discovery/     # canonical reference flow
    └── hello-world/            # smallest possible flow for docs
```

### 3.2 Runtime Requirements

- **Node.js**: ≥ 20.10 LTS. Uses native `node:fs/promises`, `node:child_process`, `node:stream`, top-level await.
- **TypeScript**: 5.4+. Library is published as ESM with `.d.ts`. No CJS dual-publish for v1 — keep the build simple.
- **`claude` CLI**: must be installed and authenticated on the user's machine. The runner does not vendor it. If absent, the runner errors on startup with installation instructions.
- **Bun / Deno**: not officially supported in v1. Likely works but not in CI matrix.

### 3.3 The Provider Abstraction

The library is built around a pluggable `Provider` interface that abstracts every interaction with an LLM. v1 ships exactly one concrete provider — `ClaudeProvider`, built on the Claude Agent SDK — but the interface is the contract every future backend (OpenAI, Gemini, Bedrock, local Ollama, etc.) MUST implement. Flow code never imports a concrete provider class; it talks to the abstraction.

**Why this matters from day one, even with one provider:**

- A flow author can write `step.prompt({ provider: 'openai', ... })` once we ship a second provider, with zero changes to the flow DSL or runner.
- Capability negotiation happens at flow-load time, not run time — if a step requests structured output but the configured provider doesn't support it, we fail with a clear error before any tokens are spent.
- The SDK-vs-subprocess decision below is a *provider implementation detail*. If Anthropic ships a direct subscription-billed API tomorrow, we add a new provider; existing flows work unchanged.

The full Provider contract — interface, capabilities, auth normalization, registry, per-step selection — is specified in §4.6.

### 3.4 Why the Claude Agent SDK (the v1 Default Provider)

The runtime uses `@anthropic-ai/claude-agent-sdk` as its transport. Two facts make this the right call:

1. **The Agent SDK is itself a subprocess wrapper around the `claude` CLI binary.** It is not a direct API client. Authentication, billing, tool dispatch, and prompt execution all flow through the user's installed `claude` binary.
2. **It respects `CLAUDE_CODE_OAUTH_TOKEN`** (confirmed via working demo at [weidwonder/claude_agent_sdk_oauth_demo](https://github.com/weidwonder/claude_agent_sdk_oauth_demo)). A user generates a long-lived OAuth token with `claude setup-token`, exports `CLAUDE_CODE_OAUTH_TOKEN=…`, and every SDK invocation bills against their Pro/Max subscription — no API charges.

Choosing the SDK over hand-rolling our own subprocess driver gives us:

- Typed message streams instead of manual `stream-json` line parsing.
- Anthropic-maintained compatibility with future `claude` CLI version changes.
- Built-in tool dispatch, MCP wiring, retry primitives, and cost surfacing.
- Smaller surface area for our own bugs.

The trade is one external runtime dep we pin and update on a schedule. Acceptable.

The SDK's authentication precedence is identical to the CLI's, so the `ANTHROPIC_API_KEY` leak that has historically caused unintentional API billing for subscribers ([issue #37686](https://github.com/anthropics/claude-code/issues/37686)) applies here too. The driver MUST defensively guard against it (see §8.1) — the SDK does not do this for us.

#### 3.4.1 Authentication paths supported (ClaudeProvider)

| Path | How user sets it up | Billing |
|---|---|---|
| Subscription OAuth (interactive) | `claude /login` once, then run | Subscription |
| Long-lived OAuth token | `claude setup-token` → export `CLAUDE_CODE_OAUTH_TOKEN` | Subscription |
| API key | export `ANTHROPIC_API_KEY` (requires explicit opt-in via `runner.allowApiKey()`) | API account |
| Cloud providers | `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` env vars | Cloud account |

Default flow: subscription OAuth or `CLAUDE_CODE_OAUTH_TOKEN`. API key billing is a deliberate opt-in to prevent surprises.

---

## 4. `@pipelinekit/core` — The Library

This is the largest section because everything else depends on it. The library has six subsystems, each addressed below.

### 4.1 Core Concepts and Vocabulary

| Term | Meaning |
|---|---|
| **Flow** | The unit a user runs. A named, versioned graph of steps with a defined entry point. |
| **Step** | A single named node in the flow. Has a type (`prompt`, `script`, `branch`, `parallel`, `terminal`), inputs, and outputs. |
| **Run** | A single execution of a flow. Has a unique run ID, a working directory, a state file, and a log. |
| **Context** | Per-run runtime state passed through the flow. Holds the run ID, working directory, env config, and accumulated handoffs. |
| **Handoff** | JSON written by one step and read by later steps. The mechanism by which structured context flows between prompts. |
| **Artifact** | Any file a step produces. Includes the handoff JSON but also free-form outputs (HTML reports, markdown, etc.). |
| **Checkpoint** | The serialized state of a run, written after every step. Allows resume after crash or `--resume`. |
| **Driver** | The component that actually invokes Claude. v1 ships one: `ClaudeCliDriver` (subprocess). |

### 4.2 Public API Surface

The library exports a small surface. Internal helpers are not re-exported.

```ts
// Defining a flow
export function defineFlow<TInput>(spec: FlowSpec<TInput>): Flow<TInput>;

// Step builders (used inside defineFlow)
export const step: {
  prompt(spec: PromptStepSpec): Step;
  script(spec: ScriptStepSpec): Step;
  branch(spec: BranchStepSpec): Step;
  parallel(spec: ParallelStepSpec): Step;
  terminal(spec: TerminalStepSpec): Step;
};

// Running a flow
export function createRunner(opts?: RunnerOptions): Runner;

// Programmatic helpers (rare; mainly for the CLI)
export class StateMachine { /* see §4.4 */ }
export class HandoffStore { /* see §4.5 */ }
export class CostTracker { /* see §4.7 */ }
export class Logger { /* see §4.8 */ }

// Provider abstraction — see §4.6
export interface Provider { /* ... */ }
export interface ProviderCapabilities { /* ... */ }
export interface InvocationRequest { /* ... */ }
export interface InvocationResponse { /* ... */ }
export interface InvocationContext { /* ... */ }
export interface AuthState { /* ... */ }
export class ProviderRegistry { /* ... */ }
export class ClaudeProvider implements Provider { /* v1 default */ }
export class ProviderAuthError extends PipelineError { /* ... */ }
export class ProviderCapabilityError extends FlowDefinitionError { /* ... */ }

// Errors — see §8.2
export class PipelineError extends Error { /* ... */ }
export class FlowDefinitionError extends PipelineError { /* ... */ }
export class StepFailureError extends PipelineError { /* ... */ }
export class ClaudeAuthError extends PipelineError { /* ... */ }
export class HandoffSchemaError extends PipelineError { /* ... */ }
```

### 4.3 The Flow DSL

Flow definition is the most-touched user surface. It must feel idiomatic to a TypeScript developer reading it for the first time.

#### 4.3.1 The `defineFlow` shape

```ts
import { defineFlow, step } from '@pipelinekit/core';
import { z } from 'zod';

const InventorySchema = z.object({
  packages: z.array(z.object({
    path: z.string(),
    name: z.string(),
    language: z.enum(['ts', 'py', 'go', 'rust', 'other']),
  })),
});

export default defineFlow({
  name: 'codebase-discovery',
  version: '0.1.0',
  description: 'Produces an HTML report describing an unknown codebase.',
  input: z.object({
    repoPath: z.string(),
    audience: z.enum(['pm', 'dev', 'both']).default('both'),
  }),

  steps: {
    inventory: step.prompt({
      promptFile: 'prompts/01_inventory.md',
      model: 'sonnet',
      tools: ['Read', 'Glob', 'Grep'],
      output: { handoff: 'inventory', schema: InventorySchema },
      maxRetries: 1,
    }),

    entities: step.prompt({
      promptFile: 'prompts/02_entities.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'entities' },
    }),

    services: step.prompt({
      promptFile: 'prompts/03_services.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'services' },
    }),

    designReview: step.parallel({
      dependsOn: ['entities', 'services'],
      branches: ['entities', 'services'],
    }),

    report: step.prompt({
      promptFile: 'prompts/04_report.md',
      dependsOn: ['designReview'],
      contextFrom: ['inventory', 'entities', 'services'],
      output: { artifact: 'report.html' },
    }),
  },

  start: 'inventory',
});
```

#### 4.3.2 Why `steps` is a record, not an array

A `Record<string, Step>` makes step IDs first-class TypeScript identifiers. `dependsOn: ['inventory']` is a string array today but a future iteration of the DSL can make it a typed string-literal union derived from `keyof typeof steps`, giving compile-time errors when a dependency name is wrong. v1 ships untyped string arrays; the type-level upgrade is non-breaking.

#### 4.3.3 Inferred dependency graph

The runner builds the execution DAG from each step's `dependsOn` field. There is no separate `start: <id>` requirement when only one step has no dependencies — the runner detects entry points automatically. `start` is optional and only needed when multiple roots exist or when the author wants an explicit entry point. Cycles fail at flow load with `FlowDefinitionError`.

### 4.4 Step Types

Five step types ship in v1. Each maps to a concrete TS class in the runtime but users only construct them via the `step.*` builders.

#### 4.4.1 `step.prompt`

Invokes Claude with a rendered prompt. The workhorse step type — 80% of flow steps will be prompt steps.

```ts
type PromptStepSpec = {
  promptFile: string;              // relative to flow dir
  provider?: string;               // provider name; falls back to flow / runner default (§4.6.6)
  model?: string;                  // provider-specific model id; provider validates
  tools?: string[];                // names from provider.capabilities.builtInTools
  systemPrompt?: string;           // optional system override
  contextFrom?: string[];          // handoffs from prior steps to inject as <context> blocks
  output: PromptStepOutput;
  dependsOn?: string[];
  maxRetries?: number;             // default: 0
  maxBudgetUsd?: number;           // requires provider.capabilities.budgetCap === true
  timeoutMs?: number;              // default: 600_000 (10 min)
  onFail?: 'abort' | 'continue' | string;  // step ID to jump to on failure
  providerOptions?: Record<string, unknown>;  // opaque escape hatch — passed through unchanged
};

type PromptStepOutput =
  | { handoff: string; schema?: ZodSchema }       // Claude returns JSON, validated, stored as handoff
  | { artifact: string }                           // Claude returns free-form text, written to file
  | { handoff: string; artifact: string; schema?: ZodSchema }; // both
```

Behavior at runtime:

1. Render the prompt template (see §4.5.2 for context injection).
2. Build the `claude -p` argv with `--output-format stream-json --verbose --model <m>` and any `--allowedTools`, `--json-schema`, `--max-budget-usd` flags.
3. Spawn the subprocess with `inheritEnv: false` (see §8.1) plus a curated env allowlist.
4. Stream-parse stdout for the CLI envelope (see §4.6.2). Update a per-step live state file every time we see a token-usage event.
5. On exit code 0: validate output against `schema` if provided; write handoff and/or artifact; record cost.
6. On non-zero exit: retry up to `maxRetries`, then route to `onFail`.

#### 4.4.2 `step.script`

Runs a shell command. Used for setup, validation, post-processing, or invoking external tools.

```ts
type ScriptStepSpec = {
  run: string | string[];          // shlex-split if string
  cwd?: string;                    // default: flow run dir
  env?: Record<string, string>;    // merged onto base env
  dependsOn?: string[];
  timeoutMs?: number;
  onExit?: Record<string, string>; // map "0" -> next step id, "default" -> abort
  onFail?: 'abort' | 'continue' | string;
  output?: { artifact?: string };  // optional: capture stdout to a file
};
```

Mirrors monolith's `script` step type. Exit-code-based routing is supported but optional — without `onExit`, exit 0 is success and any other code is failure.

#### 4.4.3 `step.branch`

Same as `script` but conceptually used for routing decisions — no artifact, just a side-effect-free check that returns an exit code.

```ts
type BranchStepSpec = Omit<ScriptStepSpec, 'output'> & {
  onExit: Record<string, string>;  // required for branches
};
```

#### 4.4.4 `step.parallel`

Runs multiple already-defined steps concurrently. The branches must already exist as separate steps; `parallel` only orchestrates fan-out / fan-in.

```ts
type ParallelStepSpec = {
  branches: string[];              // names of other steps in this flow
  dependsOn?: string[];
  onAllComplete?: string;
  onFail?: 'abort' | string;
};
```

Implementation: `Promise.all` over the branches' step executors. If any branch rejects, the parallel step rejects with an aggregate error and routes via `onFail`.

#### 4.4.5 `step.terminal`

Ends the flow with a final message and an exit code.

```ts
type TerminalStepSpec = {
  message?: string;
  exitCode?: number;               // default: 0
  dependsOn?: string[];
};
```

Most flows do not need an explicit terminal step — when execution reaches a leaf with no successors, the runner exits 0 by default.

### 4.5 Handoffs and Context Injection

The handoff system is the second-most-important primitive after the step runtime. Bad handoffs make every prompt step harder; good handoffs make them trivial.

#### 4.5.1 The `HandoffStore`

Each run has a single `HandoffStore` instance backed by `<runDir>/handoffs/`. One file per handoff, named `<handoffId>.json`. Stored as pretty-printed JSON for inspectability.

```ts
class HandoffStore {
  constructor(runDir: string);
  write(id: string, value: unknown, schema?: ZodSchema): Promise<void>;
  read<T = unknown>(id: string, schema?: ZodSchema): Promise<T>;
  exists(id: string): Promise<boolean>;
  list(): Promise<string[]>;
}
```

Writes are atomic (`write-temp + rename`). Reads validate against the optional schema. Schema mismatches throw `HandoffSchemaError`.

#### 4.5.2 Context Injection

When a prompt step declares `contextFrom: ['inventory', 'entities']`, the runner renders the prompt template with each named handoff injected as a tagged block:

```
<context name="inventory">
{ ...the inventory handoff JSON... }
</context>

<context name="entities">
{ ...the entities handoff JSON... }
</context>

<prompt>
... the body of prompts/02_entities.md, with template variables substituted ...
</prompt>
```

The prompt template itself can reference handoff fields by mustache-style placeholder if the author prefers inlining over the `<context>` block:

```markdown
The repo has {{inventory.packages.length}} packages.
Focus on {{inventory.packages[0].language}}-language services first.
```

Templates are rendered with a small custom renderer (no external dep — Mustache and Handlebars are both overkill). Supported syntax: `{{name}}`, `{{name.path.to.field}}`, `{{name[i].field}}`, `{{#each name}}...{{/each}}`. Document the supported syntax explicitly; do not promise full Mustache.

#### 4.5.3 Why JSON, Not a Typed Object Bag

Handoffs cross process boundaries (prompts run in Claude, which is a subprocess) and persist across runs (so resume can pick up handoffs from a prior partial run). They have to be JSON. The schema layer (`zod`) gives us TS-typed reads in flow code while keeping the wire format honest.

### 4.6 Providers — The Pluggable LLM Abstraction

This is the most important architectural section in the spec. Get the abstraction right and the library is open to OpenAI, Gemini, Bedrock, local models, and future Anthropic surfaces with no changes outside `packages/core/src/providers/`. Get it wrong and we paint ourselves into a Claude-only corner.

A note on naming: the `Provider` interface is what the user might call a "runner" — the thing that actually invokes an LLM. We call it `Provider` to keep it distinct from `Runner` (the flow orchestrator from §4.9). All references below use `Provider`.

#### 4.6.1 The `Provider` interface

```ts
export interface Provider {
  /** Stable identifier used in flow definitions and the registry. */
  readonly name: string;

  /** Self-described capabilities. The runner uses these for static checks. */
  readonly capabilities: ProviderCapabilities;

  /**
   * Pre-flight: verify the provider can be used right now.
   * Throws ProviderAuthError on misconfig. Called once per Runner.run().
   */
  authenticate(): Promise<AuthState>;

  /** Execute a single LLM invocation. Required. */
  invoke(req: InvocationRequest, ctx: InvocationContext): Promise<InvocationResponse>;

  /**
   * Optional: per-token streaming for the live progress display.
   * If omitted, the runner falls back to coarser per-step events.
   */
  stream?(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent>;

  /** Optional: pre-run cost estimate for the CLI banner. */
  estimateCost?(req: InvocationRequest): Promise<CostEstimate>;

  /** Optional: dispose any long-lived resources (sockets, child processes). */
  close?(): Promise<void>;
}
```

#### 4.6.2 Capabilities

Capabilities are how a provider tells the library what it can and cannot do. Step builders (§4.4) check these at flow-load time and throw `FlowDefinitionError` if a step requests something the configured provider lacks.

```ts
export interface ProviderCapabilities {
  /** True if the provider can stream tokens incrementally. */
  streaming: boolean;

  /** True if the provider can enforce JSON-schema-shaped output server-side. */
  structuredOutput: boolean;

  /** True if the provider supports tool/function calling. */
  tools: boolean;

  /** Names of built-in tools advertised to step.prompt({ tools }). Empty if not applicable. */
  builtInTools: readonly string[];

  /** True if the provider supports multimodal (image, audio, etc.) input. */
  multimodal: boolean;

  /** True if the provider can be told a per-call USD budget cap. */
  budgetCap: boolean;

  /** Catalog of model identifiers this provider accepts. Empty array means "any string allowed". */
  models: readonly string[];

  /** Maximum context window across all advertised models. Informational. */
  maxContextTokens: number;
}
```

#### 4.6.3 Normalized invocation shape

The library defines a single normalized request/response shape that every provider MUST translate to and from. This is what isolates flow code from provider quirks.

```ts
export interface InvocationRequest {
  prompt: string;                      // already-rendered, with handoff context blocks
  model?: string;                      // provider-specific id; provider validates
  systemPrompt?: string;
  tools?: string[];                    // names from provider.capabilities.builtInTools
  jsonSchema?: object;                 // already converted from Zod via zod-to-json-schema
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Provider-specific opaque options — escape hatch, not used by core. */
  providerOptions?: Record<string, unknown>;
}

export interface InvocationContext {
  flowName: string;
  runId: string;
  stepId: string;
  attempt: number;                     // 1-based retry counter
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface InvocationResponse {
  text: string;                        // canonical agent output (free-form OR JSON string)
  usage: NormalizedUsage;
  costUsd: number;                     // estimated; see §4.7 caveat about subscription billing
  durationMs: number;
  numTurns: number;
  sessionId?: string;
  model: string;
  stopReason: string | null;
  /** Raw provider-specific payload, preserved for debugging. */
  raw?: unknown;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type InvocationEvent =
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'tool.call'; name: string; input?: unknown }
  | { type: 'tool.result'; name: string; ok: boolean }
  | { type: 'usage'; usage: Partial<NormalizedUsage> }
  | { type: 'turn.end'; turn: number };
```

Three rules for providers implementing this:

1. **Translate, don't expose.** A provider that uses snake_case fields internally MUST emit camelCase on the wire. Quirks stop at the provider boundary.
2. **Always populate `usage`, even if approximate.** Cost tracking depends on it. Zeros are valid only when truly unknown (e.g., a mock provider in tests).
3. **`costUsd` is the API-equivalent estimate.** What the user actually pays depends on their billing arrangement (subscription, API account, cloud). The CLI's banner labels this honestly (§4.7).

#### 4.6.4 Auth state

Every provider returns a normalized `AuthState` from `authenticate()`. The Runner uses this for the pre-run banner and to populate the `doctor` command output.

```ts
export interface AuthState {
  ok: boolean;
  /** Stable identifier for the billing source. Surfaced in CLI/logs. */
  billingSource: 'subscription' | 'api-account' | 'bedrock' | 'vertex' | 'foundry' | 'local' | 'unknown';
  /** Human-readable detail (e.g., "Pro subscription via CLAUDE_CODE_OAUTH_TOKEN"). */
  detail: string;
  /** Optional: the account/user identifier the provider is authenticated as. */
  account?: string;
  /** Warnings the user should see (e.g., "CLAUDE_CODE_OAUTH_TOKEN expires in 14 days"). */
  warnings?: string[];
}
```

#### 4.6.5 The `ProviderRegistry`

A small in-process registry maps provider names to instances. Used by the runner to resolve `provider: 'claude'` references in flow definitions.

```ts
export class ProviderRegistry {
  register(provider: Provider): void;
  get(name: string): Provider;          // throws if missing
  has(name: string): boolean;
  list(): readonly Provider[];
}
```

The library exposes a singleton default registry pre-populated with `ClaudeProvider`. Users can replace, augment, or pass a custom registry to the Runner:

```ts
import { createRunner, ProviderRegistry, ClaudeProvider } from '@pipelinekit/core';
import { OpenAIProvider } from '@pipelinekit/provider-openai';   // future package

const registry = new ProviderRegistry();
registry.register(new ClaudeProvider());
registry.register(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));

const runner = createRunner({ providers: registry });
```

#### 4.6.6 Provider selection — three layers

Resolution order when a `prompt` step needs to know which provider to use:

1. **Step-level**: `step.prompt({ provider: 'openai', ... })` — explicit override on the step itself. Wins everything.
2. **Flow-level**: `defineFlow({ defaultProvider: 'claude', ... })` — flow-wide default.
3. **Runner-level**: `createRunner({ defaultProvider: 'claude' })` — process default. Falls back to `'claude'` if not specified.

This lets a flow be hetero-provider (some steps on Claude for tools, others on OpenAI for cheap classification) without contortions.

#### 4.6.7 Capability negotiation at flow load

When `Runner.run()` loads a flow, it walks every step and checks the resolved provider's capabilities against the step's requirements. Failures throw `FlowDefinitionError` BEFORE any tokens are spent. Examples:

- Step uses `output: { schema: ... }` but `provider.capabilities.structuredOutput === false` → "Provider 'foo' does not support structured output. Either remove the schema or use a provider that does."
- Step lists `tools: ['Read', 'Grep']` but `provider.capabilities.builtInTools` is empty → "Provider 'foo' does not advertise built-in tools."
- Step specifies `model: 'gpt-5'` but `provider.capabilities.models` is non-empty and doesn't include it → "Model 'gpt-5' is not in provider 'openai'.capabilities.models."

This is the payoff for having capabilities at all — a typed, programmatic answer to "will this flow work?" without running it.

#### 4.6.8 The v1 concrete provider: `ClaudeProvider`

`ClaudeProvider` is the only `Provider` shipped in v1. It is a thin adapter over `@anthropic-ai/claude-agent-sdk`.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeProvider implements Provider {
  readonly name = 'claude';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    structuredOutput: true,
    tools: true,
    builtInTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', /* ... */],
    multimodal: true,
    budgetCap: true,
    models: ['haiku', 'sonnet', 'opus'],   // accepts shortnames + fully-qualified IDs
    maxContextTokens: 200_000,
  };

  constructor(private opts: ClaudeProviderOptions = {}) {}

  async authenticate(): Promise<AuthState> {
    return inspectClaudeAuth(this.opts);   // see §8.1 — the safety guard lives here
  }

  async invoke(req: InvocationRequest, ctx: InvocationContext): Promise<InvocationResponse> {
    // Aggregate the streaming form into a single Promise<response>.
    let text = '';
    let usage = emptyUsage();
    let lastModel = req.model ?? 'sonnet';
    for await (const evt of this.stream!(req, ctx)) {
      if (evt.type === 'text.delta') text += evt.delta;
      if (evt.type === 'usage') usage = mergeUsage(usage, evt.usage);
    }
    return { text, usage, /* ... */ };
  }

  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    const env = buildEnvAllowlist(this.opts);
    const sdkStream = query({
      prompt: req.prompt,
      options: {
        model: req.model ?? 'sonnet',
        allowedTools: req.tools,
        systemPrompt: req.systemPrompt,
        output: req.jsonSchema ? { schema: req.jsonSchema } : undefined,
        env,
        abortSignal: ctx.abortSignal,
      },
    });

    for await (const sdkMsg of sdkStream) {
      yield translateSdkMessage(sdkMsg);   // SDK → InvocationEvent
    }
  }
}
```

The provider does not introduce its own retry loop — `Runner` owns retries at the step level (§4.4.1). The SDK's internal retries (network blips, rate-limit backoff) are kept enabled.

#### 4.6.9 What a future provider looks like (worked sketch)

Concrete enough to validate the abstraction: an `OpenAIProvider` would live in `@pipelinekit/provider-openai`, depend on `openai` (the npm SDK), and look like:

```ts
import OpenAI from 'openai';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    structuredOutput: true,                // Responses API supports JSON schema
    tools: true,
    builtInTools: [],                      // OpenAI's tools are user-defined, not built-in
    multimodal: true,
    budgetCap: false,                      // no built-in budget cap
    models: ['gpt-4o', 'gpt-4o-mini', 'o3', /* ... */],
    maxContextTokens: 200_000,
  };

  constructor(private opts: { apiKey: string; baseUrl?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  }

  async authenticate(): Promise<AuthState> {
    if (!this.opts.apiKey) throw new ProviderAuthError('openai', 'OPENAI_API_KEY required');
    return { ok: true, billingSource: 'api-account', detail: 'OpenAI API key' };
  }

  async invoke(req, ctx) { /* translate to chat.completions / responses, normalize back */ }
  async *stream(req, ctx) { /* translate streaming chunks to InvocationEvent */ }
}
```

Notice what stays the same (interface, normalized request/response, capabilities, auth shape) and what's free to differ (transport, auth source, model id format, cost calculation). That's the point of the abstraction.

For testing, a `MockProvider` in `@pipelinekit/core/testing` returns canned responses keyed by step ID. Flow authors use it in their own `pipelinekit test` runs.

#### 4.6.10 Authentication safety lives in the provider, not the core

§8.1 details the `ANTHROPIC_API_KEY` safety guard. That logic is owned by `ClaudeProvider.authenticate()`, NOT by the core runner. The runner just calls `provider.authenticate()` and surfaces the returned `AuthState`. This keeps Claude-specific safety reasoning in Claude-specific code; future providers will have their own analogous concerns (e.g., an `OpenAIProvider` would warn on org/project-id misconfiguration).

#### 4.6.11 Environment passthrough (provider responsibility)

Each provider decides which env vars to pass through to its underlying transport. `ClaudeProvider` builds an explicit allowlist (`PATH`, `HOME`, `USER`, `LANG`, `TZ`, `TMPDIR`, `CLAUDE_*`, opt-in `ANTHROPIC_*`, plus any step-declared `env`) and drops everything else. Other providers will have analogous lists. This stays out of `core` — the abstraction does not know about env.

### 4.7 Cost Tracking

Every prompt step appends a metrics entry. Stored at `<runDir>/metrics.json`.

```ts
type StepMetrics = {
  stepId: string;
  flowName: string;
  runId: string;
  timestamp: string;               // ISO-8601
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
  costUsd: number;                 // total_cost_usd from envelope
  sessionId: string;
  stopReason: string | null;
  isError: boolean;
};
```

`CostTracker` exposes `summary(): { totalUsd; totalTokens; perStep: StepMetrics[] }`. The CLI's `--cost` flag (and the end-of-run banner) reads from this.

> A note on subscription billing: the per-call `costUsd` reported by Claude is an **API-equivalent estimate**. When the user runs against their subscription, they are not billed this dollar amount — it just counts toward their subscription quota. The CLI's end-of-run banner labels this as "estimated API equivalent" to avoid the misunderstanding called out in [issue #20976](https://github.com/anthropics/claude-code/issues/20976).

### 4.8 The State Machine and Resume

#### 4.8.1 State file shape

`<runDir>/state.json`, atomically rewritten after every step completion:

```ts
type RunState = {
  runId: string;
  flowName: string;
  flowVersion: string;
  startedAt: string;
  updatedAt: string;
  input: unknown;                  // the original input to the run
  steps: Record<string, StepState>;
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
};

type StepState = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  artifacts?: string[];
  handoffs?: string[];
  errorMessage?: string;           // present iff status === 'failed'
};
```

#### 4.8.2 Resume protocol

`runner.resume(runDir)`:

1. Load `state.json`.
2. Verify the flow definition still matches (flow name and version). If the flow has been re-published with a breaking version bump, refuse and instruct the user to start over.
3. Compute the set of steps that are `succeeded` — skip those.
4. Re-execute everything else from the earliest pending step, respecting the DAG.

There is no per-step replay-from-mid-step. A failed prompt step re-runs from scratch.

### 4.9 The Runner

`Runner` is the orchestrator class users invoke from their entry-point script (or that the CLI invokes on their behalf).

```ts
class Runner {
  constructor(opts?: RunnerOptions);
  run(flow: Flow, input: unknown, opts?: RunOptions): Promise<RunResult>;
  resume(runDir: string): Promise<RunResult>;
  allowApiKey(): this;             // disables the ANTHROPIC_API_KEY safety check
}

type RunnerOptions = {
  providers?: ProviderRegistry;    // default: registry containing only ClaudeProvider
  defaultProvider?: string;        // default: 'claude'
  logger?: Logger;
  runDir?: string;                 // default: ./.pipelinekit/runs/<runId>
};

type RunOptions = {
  resumeFrom?: string;             // step id to start from (skip predecessors)
  parallelism?: number;            // max concurrent prompt steps; default: 4
  liveState?: boolean;             // write per-step live state JSON; default: true
};

type RunResult = {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
};
```

Execution algorithm (single-process, in-memory DAG walker):

1. **Resolve providers.** For each prompt step, resolve the provider via the §4.6.6 chain (step → flow → runner default). Look up the instance in the `ProviderRegistry`; throw `FlowDefinitionError` if unknown.
2. **Capability check.** For each prompt step, validate its requirements against `provider.capabilities` (§4.6.7). Throw `ProviderCapabilityError` on any mismatch.
3. **Authenticate.** Call `provider.authenticate()` exactly once per provider used in the flow. Surface `AuthState` in the pre-run banner. Abort on `ok: false`.
4. **Topologically sort steps.** Fail with `FlowDefinitionError` on cycles.
5. **Initialize state file** with all steps `pending`.
6. **Maintain a ready queue** of steps whose `dependsOn` are all `succeeded`.
7. **Pull from the queue** up to `parallelism`; execute concurrently.
8. **After each step completes**, update state, append metrics, repopulate the ready queue.
9. **Stop** when (a) queue empty AND no in-flight steps (success), or (b) any required step fails with `onFail: 'abort'`.
10. **Cleanup.** Call `provider.close?()` on every provider used in this run.

Steps 1–3 happen before any tokens are spent. A misconfigured flow fails fast with a precise error.

### 4.10 Logging

Two log streams:

- **Per-run log** at `<runDir>/run.log` — newline-delimited JSON events. Captures step starts/stops, prompt invocations, retries, errors. Always on.
- **Console output** — human-readable, colorized when stdout is a TTY. Mirrors the per-run log at INFO level by default; verbose mode (`--verbose`) adds DEBUG events.

Log event shape:

```ts
type LogEvent = {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  flowName: string;
  runId: string;
  stepId?: string;
  event: string;                   // e.g. 'step.start', 'prompt.token_update', 'step.failed'
  data?: Record<string, unknown>;
};
```

No structured-log library dependency. Plain `JSON.stringify` writes to a `WriteStream`. `Logger` is a class so flow authors can replace it (e.g., to ship events to a remote sink).

---

## 5. `@pipelinekit/cli` — The Runner

The CLI is what end users see. It must be friction-free for a non-developer to install and run a flow.

### 5.1 Distribution and Invocation

Published as `@pipelinekit/cli`. Two recommended install paths:

```bash
# Recommended for repeated use
npm install -g @pipelinekit/cli
pipelinekit run codebase-discovery .

# Recommended for one-off use
npx @pipelinekit/cli run codebase-discovery .
```

`bin` entry: `pipelinekit` → `dist/cli.js`. Single binary; subcommands dispatched via `commander` or `cac`.

### 5.2 Commands

| Command | Purpose |
|---|---|
| `pipelinekit list` | List installed flows and discoverable catalog flows. |
| `pipelinekit search <query>` | Search the remote catalog. |
| `pipelinekit install <flow>[@<version>]` | Install a catalog flow into `./.pipelinekit/flows/<flow>/`. |
| `pipelinekit run <flow> [<input...>]` | Run an installed flow. Auto-installs if not present. |
| `pipelinekit resume <runId>` | Resume a previously failed or interrupted run. |
| `pipelinekit runs` | List recent runs in this directory. |
| `pipelinekit upgrade [<flow>]` | Re-fetch latest version of one or all installed flows. |
| `pipelinekit doctor` | Diagnostic: checks `claude` install, auth state, env safety. |
| `pipelinekit new <name>` | Scaffold a new flow in the current directory (delegates to generator templates). |

#### 5.2.1 `run` command UX

The contract from the user's prompt — `npx pipelinekit <flow> <input>` — is supported as `pipelinekit run <flow> <input>`. When invoked without `run`, the CLI infers `run` if the first positional argument matches an installed flow name. The shorthand is `pipelinekit <flow> [<input...>]`.

Inputs are forwarded as the flow's `input` schema. By convention, the first positional arg is the primary subject (a path, URL, or short identifier); additional arguments and `--key=value` flags populate other input fields. The flow's `input` Zod schema determines parsing rules; the CLI uses the Zod schema's metadata to render `--help` text.

#### 5.2.2 `doctor` command

Critical for billing safety:

```
$ pipelinekit doctor
✓ Node 20.10.0 (>= 20.10 required)
✓ claude CLI found at /usr/local/bin/claude (v2.4.1)
✓ claude is authenticated (subscription: max)
✗ ANTHROPIC_API_KEY is set in your environment
  → If you run flows now, prompts will bill against your API account
    instead of your Max subscription. Run `unset ANTHROPIC_API_KEY`
    or restart your shell after removing it from your shell rc files.
✓ ./.pipelinekit/ directory writable
```

Exit code 0 only if all checks pass. CI-friendly.

### 5.3 Flow Installation

#### 5.3.1 Resolution order

Given `pipelinekit run codebase-discovery`, the CLI resolves the flow in this order:

1. Local: `./.pipelinekit/flows/codebase-discovery/`
2. Local workspace package: `./node_modules/@ganderbite/flow-codebase-discovery/`
3. Remote catalog: `https://flows.pipelinekit.dev/registry.json` → fetch tarball.

A locally installed flow always wins. The CLI prints which source it resolved.

#### 5.3.2 Installation mechanics

Catalog flows are published as plain npm packages (e.g., `@ganderbite/flow-codebase-discovery`). The CLI's `install` command runs `npm install --no-save --prefix ./.pipelinekit/flows/<flow>` against the package, then resolves and unpacks it into a flat directory matching the Flow Package layout (§7).

Why npm and not a custom registry: npm already has versioning, signing, mirroring, security advisories, and a publish workflow. A custom registry is a v2+ project.

#### 5.3.3 Local mode

Authors developing a flow in the same workspace can run it directly:

```
pipelinekit run ./path/to/flow-dir
```

If the first positional looks like a path (starts with `./`, `../`, `/`, or contains `/`), the CLI treats it as a local flow directory, skipping resolution.

### 5.4 Runtime Behavior

The CLI delegates to `Runner` from `@pipelinekit/core`. Its job is to:

- Parse args into the flow's `input` shape.
- Construct a `Runner` with sensible defaults (logging to stdout + run dir, parallelism = 4, default `ClaudeCliDriver`).
- Print a startup banner (flow name, version, estimated cost, run dir).
- Stream a TTY-aware progress display (see §5.5).
- On exit, print a final summary including total cost and the path to the primary artifact.

### 5.5 Progress Display

When stdout is a TTY, render a live, single-screen status using the per-step live-state files written by the driver. Suggested layout:

```
codebase-discovery v0.1.0  ·  run f9c3a2  ·  est. $0.40

  ✓ inventory       sonnet   2.1s   1.4K in / 0.3K out   $0.005
  ⠋ entities        sonnet   running (turn 3) 0.8K in / 0.4K out
  ⠋ services        sonnet   running (turn 2) 0.7K in / 0.3K out
  · designReview    pending
  · report          pending

  Press Ctrl+C to abort (state saved; resume with `pipelinekit resume f9c3a2`)
```

When stdout is not a TTY (CI, redirected to file), fall back to one INFO line per state transition.

---

## 6. `@pipelinekit/generator` — The Claude Code Skill

The generator is **internal to Ganderbite** for v1 (per the deep-dive's "studio model"). It is shipped publicly so that power users can scaffold their own flows, but the team's own internal use is the primary justification.

### 6.1 What It Is

A Claude Code skill packaged as `@pipelinekit/generator`. Installation copies `skill/SKILL.md` and supporting templates into the user's `.claude/skills/pipelinekit-generator/`.

### 6.2 What It Does

Triggered by natural-language prompts inside Claude Code:

- "scaffold a new pipelinekit flow that..."
- "generate a pipeline for ..."
- "/pipelinekit-new <description>"

The skill walks the user through:

1. Naming the flow (kebab-case).
2. Eliciting the high-level steps (LLM-assisted, but the user confirms each).
3. Choosing models per step (default: sonnet across the board).
4. Generating: `flow.ts`, `prompts/<step>.md` skeletons, `package.json`, `README.md`, `tsconfig.json`.

Output is a directory matching the Flow Package format (§7). The generated flow compiles and runs immediately, even if the prompts are placeholders.

### 6.3 What It Does Not Do

- Does not build or modify the library. It only emits flow packages.
- Does not run flows — that's the CLI's job.
- Does not have its own runtime — it uses Claude Code's `Write`, `Read`, and `AskUserQuestion` tools.

### 6.4 Internal vs Public

Per the deep-dive's recommendation: "Layer 1: GENERATOR — internal factory tool — not public." The generator IS published (so users can use it) but is positioned in marketing materials as an optional convenience, not the headline product. The headline product is the catalog (the flows themselves).

If the generator turns out to be a hit on its own, that's upside — but the spec assumes the catalog flows drive adoption.

### 6.5 Templates

Generator templates live in `packages/generator/templates/`. Each template is a small directory matching the Flow Package format with placeholders. v1 templates:

- `blank/` — minimal flow with one prompt step.
- `linear/` — N prompt steps in series.
- `fan-out/` — fan-out / fan-in pattern (parallel).
- `discovery/` — modeled on `codebase-discovery` (the canonical example).

The skill picks a template based on the user's described intent, then customizes per-step prompts via inline LLM calls.

---

## 7. The Flow Package Format

This is the contract that ties §4, §5, §6, and the catalog together. Every flow — whether installed from the catalog, generated by the skill, or hand-written — has the same shape.

### 7.1 Directory Layout

```
codebase-discovery/
├── package.json           # name, version, deps on @pipelinekit/core
├── flow.ts                # the defineFlow() entry point — default export
├── prompts/
│   ├── 01_inventory.md
│   ├── 02_entities.md
│   ├── 03_services.md
│   └── 04_report.md
├── schemas/               # optional: shared Zod schemas
│   └── inventory.ts
├── templates/             # optional: output templates (HTML, markdown)
│   └── report.html.ejs
├── examples/              # optional: sample outputs for the README
│   └── sample-output.html
├── README.md              # user-facing docs (see §7.4)
└── tsconfig.json          # extends @pipelinekit/core/tsconfig
```

### 7.2 `package.json` Requirements

```json
{
  "name": "@ganderbite/flow-codebase-discovery",
  "version": "0.1.0",
  "description": "...",
  "type": "module",
  "main": "./dist/flow.js",
  "files": ["dist", "prompts", "schemas", "templates", "examples", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "pipelinekit test ."
  },
  "peerDependencies": {
    "@pipelinekit/core": "^1.0.0"
  },
  "pipelinekit": {
    "displayName": "Codebase Discovery",
    "tags": ["discovery", "documentation"],
    "estimatedCostUsd": { "min": 0.20, "max": 0.80 },
    "estimatedDurationMin": { "min": 5, "max": 20 },
    "audience": ["pm", "dev"]
  }
}
```

The `pipelinekit` block is read by the CLI's `list`, `search`, and pre-run banner. It is not consumed by `@pipelinekit/core` itself.

### 7.3 The Entry Point

`flow.ts` MUST default-export a `Flow` object:

```ts
import { defineFlow, step } from '@pipelinekit/core';
export default defineFlow({ /* ... */ });
```

The CLI loads this via dynamic ESM `import()`. Flows are compiled to JS at publish time (so the CLI never invokes `tsc` — fast, dependency-free at install time).

### 7.4 README Template

Every flow's README MUST contain (in order):

1. **What it does** — one paragraph.
2. **Sample output** — image or excerpt.
3. **Estimated cost and duration**.
4. **Install command**.
5. **Run command** with the most common arguments.
6. **Configuration** — what knobs the flow exposes.
7. **Customization guide** — how to fork and adapt.
8. **License**.

This is enforced lightly by `pipelinekit publish` (§9.4) — missing sections are warnings, not errors, but the catalog homepage rejects flows that lack 1–5.

### 7.5 Versioning

Every flow follows strict semver. Breaking changes to the flow's `input` schema, removal of artifacts, or rename of public outputs require a major bump. Adding optional inputs or new artifacts is a minor bump. Patch bumps are prompt tweaks and bug fixes.

The catalog client respects npm semver; `pipelinekit install codebase-discovery@^0.1.0` is honored.

---

## 8. Cross-Cutting Concerns

### 8.1 Authentication and Billing Safety

This is the single most important non-functional requirement. The library MUST NOT cause unintentional API billing for users with a Pro/Max subscription.

#### 8.1.1 The threat model

The user has a subscription. They install pipelinekit and run a flow. Several environments can silently route their tokens to the API:

- `ANTHROPIC_API_KEY` is set in their shell rc (a leftover from earlier API experimentation).
- A parent process exported `ANTHROPIC_API_KEY` for some other tool.
- A CI runner has `ANTHROPIC_API_KEY` injected by the platform.

The Claude Agent SDK's authentication precedence (inherited from the underlying `claude` CLI) puts `ANTHROPIC_API_KEY` ahead of subscription credentials. Without intervention, a long-running flow can silently rack up tens or hundreds of dollars on the API account before the user notices ([issue #37686](https://github.com/anthropics/claude-code/issues/37686)).

#### 8.1.2 The contract

The driver enforces this protocol on every invocation:

1. Inspect the inherited environment before calling the SDK.
2. If `ANTHROPIC_API_KEY` is set AND `PIPELINEKIT_ALLOW_API_KEY` is NOT set AND `runner.allowApiKey()` was NOT called, throw `ClaudeAuthError` with a clear remediation message. Do NOT call the SDK.
3. If the user explicitly opts into API key mode, proceed but log a single-line warning per run: `WARN: ANTHROPIC_API_KEY active — billing to API account, not subscription`.
4. The `pipelinekit doctor` command makes this state inspectable without running a flow.
5. The pre-run banner displays the active billing mode: `Billing: subscription (token)`, `Billing: subscription (interactive)`, `Billing: API account`, or `Billing: bedrock` / `vertex` / `foundry`.

This is a deliberate design choice: we trade a small amount of friction (the user must explicitly opt in to API billing) for the much larger downside protection (no surprise four-figure bills). The Agent SDK does not provide this guard for us — we have to enforce it ourselves before every call.

#### 8.1.3 CI usage

For CI, the user generates `CLAUDE_CODE_OAUTH_TOKEN` once via `claude setup-token` and stores it as a CI secret. The driver detects it and the SDK uses it; this token is subscription-billed. No `ANTHROPIC_API_KEY` should ever be set in a pipelinekit CI environment. The `doctor` command should be the first step in any CI job that runs pipelinekit, so the build fails loudly at setup if the env is misconfigured.

### 8.2 Error Handling

A small, typed error hierarchy:

```ts
class PipelineError extends Error {
  code: string;                    // machine-readable
  details?: Record<string, unknown>;
}

class FlowDefinitionError extends PipelineError {}   // bad DSL usage; thrown at load
class StepFailureError extends PipelineError {       // step exited non-zero
  stepId: string;
  attempt: number;
}
class ClaudeAuthError extends PipelineError {}       // env unsafe; pre-spawn
class HandoffSchemaError extends PipelineError {     // bad handoff JSON
  handoffId: string;
  issues: ZodIssue[];
}
class TimeoutError extends PipelineError {
  stepId: string;
  timeoutMs: number;
}
```

The CLI maps these to exit codes:

- `0` — success
- `1` — generic step failure (`StepFailureError`)
- `2` — flow definition error (`FlowDefinitionError`)
- `3` — auth / environment error (`ClaudeAuthError`)
- `4` — handoff / schema error (`HandoffSchemaError`)
- `5` — timeout (`TimeoutError`)

Each error includes the run ID and run dir so users can resume after fixing.

### 8.3 Schema Validation with Zod

Zod is the only mandatory dep beyond Node built-ins. Used for:

- Flow `input` schemas (parsed by the CLI from positional args / flags).
- Handoff schemas (validated on read AND write).
- Step-level prompt output schemas (forwarded to `claude --json-schema`).

The library re-exports `z` for convenience: `import { z } from '@pipelinekit/core'`. This lets flow authors avoid pinning their own Zod version mismatched with the library's.

### 8.4 Telemetry

Off by default. Opt-in via `pipelinekit config set telemetry.enabled true`. If enabled, sends a single anonymized event per run to `https://telemetry.pipelinekit.dev/runs`:

```json
{
  "flowName": "codebase-discovery",
  "flowVersion": "0.1.0",
  "status": "succeeded",
  "durationMs": 412000,
  "stepsCount": 5,
  "totalCostUsd": 0.42,
  "pipelinekitVersion": "0.1.0",
  "nodeVersion": "20.10.0",
  "platform": "darwin"
}
```

No flow input data, no prompt content, no artifacts, no path strings. The `flowName` and `flowVersion` are the only fields tying a run to the catalog.

### 8.5 Atomic Writes

All file writes that other processes might read (state.json, handoffs/*.json, metrics.json, live-state files) use the temp-file-and-rename pattern. The library exposes a tiny `atomicWriteJson(path, value)` helper used internally and made available to flow authors who write artifacts of their own.

---

## 9. Milestones and Acceptance Criteria

The plan is sized to ship a credible v1 in roughly six weeks of focused work. Each milestone is independently shippable.

### 9.1 M1 — Library MVP (Weeks 1–2)

Ship: `@pipelinekit/core` v0.1.0 to npm.

Acceptance:
- `defineFlow` + `step.prompt` + `step.script` work end-to-end.
- `Provider` interface, `ProviderRegistry`, and `ClaudeProvider` are public, documented, and unit-tested.
- A two-step flow defined in the `examples/hello-world` directory runs against a real `claude` CLI on a Max subscription with no API charges.
- A second example flow (`examples/hello-world-mocked`) runs entirely against `MockProvider` with no Claude installed — proves the abstraction holds.
- `Runner.run()` writes a complete `state.json`, `metrics.json`, and `run.log`.
- `Runner.resume()` correctly skips succeeded steps after killing a flow mid-execution.
- Capability-mismatch failures are caught at flow load (write a regression test using `MockProvider` with `structuredOutput: false`).
- `pipelinekit doctor` (stub from `cli`) detects `ANTHROPIC_API_KEY` and aborts with the §8.1 message.
- 80% line coverage on `core` with `MockProvider`.

### 9.2 M2 — CLI MVP (Weeks 2–3)

Ship: `@pipelinekit/cli` v0.1.0 to npm.

Acceptance:
- `pipelinekit run ./path/to/flow <input>` works end-to-end.
- `pipelinekit doctor` covers all checks listed in §5.2.2.
- `pipelinekit runs` lists past runs in the current dir.
- `pipelinekit resume <runId>` works.
- `pipelinekit install` resolves and installs an npm-published flow package.
- `pipelinekit list` lists installed flows.
- TTY progress display works on macOS Terminal and iTerm2.

### 9.3 M3 — Reference Flow (Weeks 3–4)

Ship: `@ganderbite/flow-codebase-discovery` v0.1.0.

Acceptance:
- Port `discovery-framework` into the Flow Package format.
- The flow runs end-to-end on a real codebase (use the pipelinekit monorepo itself as a fixture).
- Generated HTML report opens in a browser and contains all six sections.
- README satisfies §7.4 in full.
- Total runtime < 20 minutes; total cost < $1 (estimated API equivalent).

### 9.4 M4 — Catalog Plumbing (Weeks 4–5)

Ship: catalog website + `pipelinekit publish`.

Acceptance:
- Static site at `flows.pipelinekit.dev` listing every published flow with cost/duration estimates and sample outputs.
- `pipelinekit publish ./path/to/flow` lints the flow against the §7 spec, builds it, and publishes the npm package.
- Catalog `registry.json` is generated from the npm registry; `pipelinekit search` queries it.
- One additional flow shipped (suggestion: `api-audit`).

### 9.5 M5 — Generator Skill (Weeks 5–6)

Ship: `@pipelinekit/generator` v0.1.0.

Acceptance:
- `pipelinekit-generator` skill installable via `npm install -g @pipelinekit/generator && pipelinekit-generator install`.
- Triggers on relevant natural language inside Claude Code.
- Generates a flow that compiles and runs without further intervention.
- The generated flow uses the canonical project layout (§7.1).
- The internal team uses it to scaffold the third launch flow.

### 9.6 Cut-Off Criteria for v1.0

Ship v1.0 when M1–M5 are done AND:

- Three Verified-tier flows are live in the catalog.
- The cumulative test suite is green on macOS and Linux against Node 20.10 and 22 LTS.
- A 30-minute walkthrough video is recorded showing PM-persona install-and-run on a fresh machine.
- The "doctor" command is mentioned in the top-level README install section.

---

## 10. Open Questions and Explicit Non-Goals

### 10.1 Open Questions (need a decision before M1 starts)

1. **Workspace tooling.** pnpm vs npm workspaces vs turbo? Recommendation: pnpm workspaces + `tsup` per package. Lightweight, conventional in the TS-library space.
2. **Logger API stability.** Should the `Logger` interface be considered stable in v1, or experimental? Implication: do we let users write their own loggers in v1, or hold that surface back to v2?
3. **Flow package compilation.** Do flow authors compile their `flow.ts` to JS before publishing (recommended: yes), or do we ship a TS loader that compiles on install? The latter is friendlier but adds startup cost; the former requires authors to run `npm run build` before `npm publish`.
4. **Naming.** "PipelineKit" is descriptive but generic. Worth checking npm and trademark availability for `pipelinekit` (and `@pipelinekit/*` scope). Fallbacks: `flowkit`, `flowkit.ai`, `cascade`, `relay`.
5. **License.** The Python monolith uses AGPL-3.0. Is AGPL still right for a TypeScript library that thirds parties will install transitively? MIT or Apache-2.0 is friendlier for adoption; AGPL is friendlier for moat-protection. Decide before npm publish.

### 10.2 Explicit Non-Goals (already decided — do not let scope creep back in)

- No skill-based flavor.
- No interactive steps.
- No GUI.
- No hosted runner.
- No brain memory.
- No DAG/wave-loop dynamic task orchestration.
- Only one concrete provider ships in v1 (`ClaudeProvider`). The `Provider` interface is public and stable; additional providers (`OpenAIProvider`, `BedrockProvider`, etc.) are explicitly out of scope for v1 but unblocked by the abstraction.
- No multi-tenant SaaS.
- No backwards-compatibility shims with monolith's manifest YAML format. (If we ever need YAML import, it's a separate package, not core.)

### 10.3 Future Work (v1.x and v2)

Not in scope but worth noting so we design v1 without painting ourselves into a corner:

- **Additional providers.** The `Provider` interface (§4.6) is the integration point. Concrete v1.x candidates: `OpenAIProvider`, `GeminiProvider`, `BedrockProvider`, `VertexProvider`, `OllamaProvider` (local), `MockProvider` (test fixture). Each ships as its own `@pipelinekit/provider-<name>` package so the core stays dep-light.
- **Type-level dependency checking.** Make `dependsOn` a string-literal union derived from `keyof typeof steps`. Non-breaking DSL upgrade.
- **Flow composition.** Allow one flow to invoke another as a sub-flow. Useful but introduces handoff-namespacing complexity.
- **Hosted runner.** A SaaS surface where users zip a repo, get the report by email. Significant infra investment; only justified if catalog flows pull a non-technical audience.
- **Eval harness.** Snapshot-based regression tests for flows (the deep-dive's "flow-level CI"). v1 ships a stub via `pipelinekit test` but the eval implementation is v1.x.

---

## Appendix A — Worked Example: `codebase-discovery` End-to-End

The example below shows what a complete flow looks like — used as the canonical illustration in docs and the M3 acceptance fixture.

`flow.ts`:

```ts
import { defineFlow, step, z } from '@pipelinekit/core';

const InventorySchema = z.object({
  packages: z.array(z.object({
    path: z.string(),
    name: z.string(),
    language: z.enum(['ts', 'py', 'go', 'rust', 'other']),
    entryPoints: z.array(z.string()),
  })),
});

const EntitiesSchema = z.object({
  entities: z.array(z.object({
    name: z.string(),
    kind: z.enum(['model', 'service', 'controller', 'util']),
    file: z.string(),
    summary: z.string(),
  })),
});

export default defineFlow({
  name: 'codebase-discovery',
  version: '0.1.0',
  description: 'Produces an HTML codebase report for PMs and devs.',
  input: z.object({
    repoPath: z.string(),
    audience: z.enum(['pm', 'dev', 'both']).default('both'),
  }),

  steps: {
    inventory: step.prompt({
      promptFile: 'prompts/01_inventory.md',
      tools: ['Read', 'Glob', 'Grep'],
      output: { handoff: 'inventory', schema: InventorySchema },
      maxRetries: 1,
    }),

    entities: step.prompt({
      promptFile: 'prompts/02_entities.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'entities', schema: EntitiesSchema },
    }),

    services: step.prompt({
      promptFile: 'prompts/03_services.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'services' },
    }),

    report: step.prompt({
      promptFile: 'prompts/04_report.md',
      dependsOn: ['entities', 'services'],
      contextFrom: ['inventory', 'entities', 'services'],
      output: { artifact: 'report.html' },
    }),
  },
});
```

`prompts/02_entities.md` (excerpt):

```markdown
You are documenting a codebase for a {{input.audience}} audience.

The package inventory is in the <context name="inventory"> block above.
Total packages: {{inventory.packages.length}}

For each package, identify the top-level entities (models, services,
controllers, utilities). Return a JSON object matching the EntitiesSchema.
```

User invocation:

```
$ pipelinekit run codebase-discovery /path/to/repo --audience=pm
codebase-discovery v0.1.0 · run f9c3a2 · est. $0.40 · billing: subscription (max)

  ✓ inventory   sonnet  2.1s   1.4K in / 0.3K out  $0.005
  ✓ entities    sonnet 18.3s   3.2K in / 1.1K out  $0.018
  ✓ services    sonnet 22.7s   3.4K in / 1.4K out  $0.024
  ✓ report      sonnet 31.2s   8.1K in / 2.6K out  $0.052

Done in 1m 14s · est. API equivalent: $0.099 · subscription quota used
Artifact: ./.pipelinekit/runs/f9c3a2/report.html
```

This is the experience M3 must deliver.

---

## Appendix B — Comparison With monolith (Reference)

For maintainers who know monolith, this maps which monolith concepts are kept, dropped, or transformed:

| monolith concept | pipelinekit v1 | Notes |
|---|---|---|
| `manifest.yaml` declarative spec | `flow.ts` typed DSL | Same role, different mechanism. |
| `FlowRunner` class | `Runner` class | Same role. |
| `FlowContext` with `$VARIABLE` substitution | Mustache-style template engine | Same role; idiomatic to TS. |
| `step.script` / `step.branch` | Same | Direct port. |
| `step.parallel` (threading) | Same (Promise.all) | Direct port. |
| `step.agent` (spawn `claude -p`) | `step.prompt` → `Provider` abstraction (default: `ClaudeProvider` over `@anthropic-ai/claude-agent-sdk`) | Same role, renamed. The pluggable `Provider` interface (§4.6) replaces monolith's hardcoded subprocess assumption. |
| `step.role_play` (exit code 10) | **Dropped** | Out of scope for prompt-based v1. |
| `step.terminal` | Same | Direct port. |
| `step.wave_loop` (DAG-driven) | **Dropped** | Out of scope for v1. |
| Brain context regeneration | **Dropped** | Tied to skill-based flavor. |
| `flow_checkpoint.json` | `state.json` | Restructured but same purpose. |
| `metrics.json` per-feature | `metrics.json` per-run | Same shape. |
| `agent_live_state_<id>.json` | Same | Same shape. |
| `effect-persist-discoveries.py` (brain writes) | **Dropped** | Brain not in v1. |
| Pre/post flow hooks | Replaced by user-defined `script` steps | Same expressiveness, no special framework hook lifecycle. |
| `ERROR_DETAILS:{json}` envelope | Typed `PipelineError` hierarchy | Better TS ergonomics. |

The deletions are deliberate — they correspond to the "no skill-based flavor" and "no interactivity" non-goals.
