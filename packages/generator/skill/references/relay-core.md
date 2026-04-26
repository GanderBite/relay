# Relay Core Reference

## §1 — Public API

All exports come from `'@ganderbite/relay-core'`.

| Export | What it is |
|---|---|
| `defineFlow(spec)` | Compiles a flow definition; default-export the result from `flow.ts` |
| `step.prompt(config)` | Invokes Claude via provider; reads `promptFile`, writes handoff or artifact |
| `step.script(config)` | Runs a shell command; optionally writes artifact |
| `step.branch(config)` | Runs a shell command; routes control flow via exit code |
| `step.parallel(config)` | Fan-in barrier; waits for all listed `branches` to complete |
| `step.terminal(config)` | Ends the flow immediately |
| `z` | Zod v4 re-export; use for all schemas in flow packages |
| `Result<T,E>` | neverthrow result type; returned by fallible core operations |
| `ResultAsync<T,E>` | async variant of `Result<T,E>` |

---

## §2 — PromptStepSpec

```typescript
interface PromptStepSpec {
  kind: 'prompt';
  promptFile: string;                          // required; path relative to flowDir
  dependsOn?: string[];                        // step ids that must succeed first
  model?: string;                              // 'sonnet' | 'opus' | 'haiku'; provider default if omitted
  tools?: string[];                            // e.g. ['Read', 'Glob', 'Grep']
  systemPrompt?: string;
  contextFrom?: string[];                      // handoff ids injected into prompt as context blocks
  output: PromptStepOutput;                    // required; one of three shapes below
  maxRetries?: number;                         // integer >= 0
  maxBudgetUsd?: number;
  timeoutMs?: number;                          // default 600000 (10 minutes)
  onFail?: 'abort' | 'continue' | string;     // string = step id to jump to
}

// Three valid output shapes:
type PromptStepOutput =
  | { handoff: string; schema?: z.ZodType }                    // JSON result passed to downstream steps
  | { artifact: string }                                        // final output file written to run dir
  | { handoff: string; artifact: string; schema?: z.ZodType }; // both
```

---

## §3 — Other Step Specs

```typescript
interface ScriptStepSpec {
  kind: 'script';
  run: string | string[];                      // shell command or argv array
  dependsOn?: string[];
  env?: Record<string, string>;
  cwd?: string;
  output?: { artifact?: string };
  onExit?: Record<string, 'abort' | 'continue' | string>; // keys: '0','1',... or 'default'
  maxRetries?: number;
  timeoutMs?: number;
  onFail?: 'abort' | 'continue' | string;
}

interface BranchStepSpec {
  kind: 'branch';
  run: string | string[];
  dependsOn?: string[];
  env?: Record<string, string>;
  cwd?: string;
  onExit: Record<string, 'abort' | 'continue' | string>; // required, non-empty
  // keys: literal 'default' or numeric string /^\d+$/
  maxRetries?: number;
  timeoutMs?: number;
  onFail?: 'abort' | 'continue' | string;
  // no output, no contextFrom
}

interface ParallelStepSpec {
  kind: 'parallel';
  branches: string[];                          // step ids; non-empty, unique
  dependsOn?: string[];
  onAllComplete?: string;                      // step id to run after all branches finish
  onFail?: 'abort' | string;                  // 'continue' is NOT valid here
  // no retry, timeout, contextFrom, or tools
}

interface TerminalStepSpec {
  kind: 'terminal';
  dependsOn?: string[];
  message?: string;
  exitCode?: number;                           // 0-255
  // no retry, timeout, output, or contextFrom
}
```

---

## §4 — Prompt Template Syntax

Prompts in `prompts/*.md` are Handlebars templates. There are two kinds of variables:

**Generator tokens** (substituted at scaffold time by the skill):
- `{{pkgName}}` → the flow name the user chose
- `{{stepNames[0]}}`, `{{stepNames[1]}}`, `{{stepNames[2]}}` → step names the user chose

**Runtime variables** (resolved when the flow runs):

| Syntax | Resolves to |
|---|---|
| `{{input.fieldName}}` | Flow input field |
| `{{handoffId}}` | Full handoff value (JSON string or text) |
| `{{handoffId.fieldName}}` | Field on a JSON handoff |
| `{{handoffId.array.length}}` | Array length on a JSON handoff |

The orchestrator prepends a context envelope before the prompt body:
```
<context>
  <c name="inventory">{json}</c>
  <c name="entities">{json}</c>
</context>

<prompt>
...prompt body...
</prompt>
```

Handoffs referenced in `contextFrom` appear as `<c name="handoffId">` blocks. Reference them by id in the prompt body using `{{handoffId.field}}`.

---

## §5 — package.json relay metadata block

```json
{
  "name": "{{pkgName}}",
  "version": "0.1.0",
  "description": "One sentence describing the flow.",
  "type": "module",
  "main": "./dist/flow.js",
  "files": ["dist", "prompts", "schemas", "templates", "examples", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "relay test ."
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "relay": {
    "flowName": "{{pkgName}}",            // optional; inferred from defineFlow name
    "displayName": "{{pkgName}}",         // human-readable; shown in catalog
    "tags": ["linear", "pipeline"],       // searchable; update after scaffolding
    "estimatedCostUsd": {
      "min": 0.05,                        // update after first few runs
      "max": 0.30
    },
    "estimatedDurationMin": {
      "min": 2,
      "max": 10
    },
    "audience": ["dev"]                   // "dev" | "pm" | "both"
  }
}
```

---

## §6 — Validation Rules

| Subject | Rule |
|---|---|
| Flow name | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` — kebab-case, starts with letter |
| Step name | same pattern as flow name |
| Reserved step names | `input`, `output`, `run`, `state` |
| Max steps at scaffold | 20 |
| Handoff id | alphanumeric start; `.` `_` `-` allowed; no `/` `\` or hidden-file chars |
| Flow version | `\d+\.\d+\.\d+` semver-ish |
| `timeoutMs` default | 600000 (10 minutes) |
| `onExit` keys | `'default'` or numeric string matching `/^\d+$/` |
| `parallel.branches` | non-empty, all values unique |
| `branch.onExit` | required, non-empty |

---

## §7 — Template File Contents

The skill writes these files verbatim, substituting `{{pkgName}}` and `{{stepNames[N]}}` with user-collected values at write time.

Note on nested tokens in linear prompt files: `{{{{stepNames[0]}}.result}}` is intentional — after generator substitution it becomes e.g. `{{analyze.result}}`, which is a runtime Handlebars variable that reads the `result` field from the `analyze` handoff.

---

### §7.1 — blank

**File tree:**
```
<flow-name>/
├── package.json
├── tsconfig.json
├── flow.ts
├── prompts/
│   └── 01_first.md
└── README.md
```

**package.json**
```json
{
  "name": "{{pkgName}}",
  "version": "0.1.0",
  "description": "A Relay flow.",
  "type": "module",
  "main": "./dist/flow.js",
  "files": [
    "dist",
    "prompts",
    "schemas",
    "templates",
    "examples",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "test": "relay test ."
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "relay": {
    "flowName": "{{pkgName}}",
    "displayName": "{{pkgName}}",
    "tags": [],
    "estimatedCostUsd": {
      "min": 0.0,
      "max": 0.0
    },
    "estimatedDurationMin": {
      "min": 1,
      "max": 5
    },
    "audience": [
      "dev"
    ]
  }
}
```

**tsconfig.json**
```json
{
  "extends": "@ganderbite/relay-core/tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": false
  },
  "include": ["flow.ts", "schemas/**/*.ts"]
}
```

**flow.ts**
```typescript
import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'A Relay flow.',
  input: z.object({
    subject: z.string(),
  }),
  steps: {
    first: step.prompt({
      promptFile: 'prompts/01_first.md',
      output: { handoff: 'result' },
    }),
  },
});
```

**prompts/01_first.md**
```
You are writing about {{input.subject}}. Produce a short paragraph describing it.

Return ONLY the paragraph text. No preamble, no headings, no commentary.
```

**README.md**
```markdown
# {{pkgName}}

## What it does

One paragraph describing what this flow produces and who it is for. Replace this text with your own description before publishing.

## Sample output

Paste an excerpt of a real run, or link to an image under `examples/`. Catalog homepage requires this section.

## Estimated cost and duration

- Cost: $0.00 – $0.00 per run (subscription billing: zero marginal cost)
- Duration: 1 – 5 minutes

Update these numbers after you run the flow a handful of times.

## Install

```
relay install {{pkgName}}
```

## Run

```
relay run {{pkgName}} --subject "your subject here"
```

## Configuration

This flow exposes the following inputs:

- `subject` (string, required) — the topic the first step writes about.

## Customization

Fork this package, edit `prompts/01_first.md` and `flow.ts`, then run `relay run .` from the flow directory to test locally.

## License

MIT
```

---

### §7.2 — linear

**File tree:**
```
<flow-name>/
├── package.json
├── tsconfig.json
├── flow.ts
├── prompts/
│   ├── 01_first.md
│   ├── 02_second.md
│   └── 03_third.md
└── README.md
```

**package.json**
```json
{
  "name": "{{pkgName}}",
  "version": "0.1.0",
  "description": "Three-step linear flow scaffolded from @ganderbite/relay-generator.",
  "type": "module",
  "main": "./dist/flow.js",
  "files": [
    "dist",
    "prompts",
    "schemas",
    "templates",
    "examples",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "test": "relay test ."
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "relay": {
    "flowName": "{{pkgName}}",
    "displayName": "{{pkgName}}",
    "tags": [
      "linear",
      "pipeline"
    ],
    "estimatedCostUsd": {
      "min": 0.05,
      "max": 0.3
    },
    "estimatedDurationMin": {
      "min": 2,
      "max": 10
    },
    "audience": [
      "dev"
    ]
  }
}
```

**tsconfig.json**
```json
{
  "extends": "@ganderbite/relay-core/tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./"
  },
  "include": ["flow.ts", "schemas/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**flow.ts**
```typescript
import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description:
    'Three-step linear flow: {{stepNames[0]}} then {{stepNames[1]}} then {{stepNames[2]}}.',
  input: z.object({
    subject: z.string().describe('The subject the flow operates on.'),
  }),
  steps: {
    '{{stepNames[0]}}': step.prompt({
      promptFile: 'prompts/01_first.md',
      output: { handoff: '{{stepNames[0]}}' },
    }),
    '{{stepNames[1]}}': step.prompt({
      promptFile: 'prompts/02_second.md',
      dependsOn: ['{{stepNames[0]}}'],
      contextFrom: ['{{stepNames[0]}}'],
      output: { handoff: '{{stepNames[1]}}' },
    }),
    '{{stepNames[2]}}': step.prompt({
      promptFile: 'prompts/03_third.md',
      dependsOn: ['{{stepNames[1]}}'],
      contextFrom: ['{{stepNames[1]}}'],
      output: { handoff: '{{stepNames[2]}}' },
    }),
  },
});
```

**prompts/01_first.md**
```
You are the first step of a three-step linear flow.

Input:
- subject: {{input.subject}}

Produce a concise result for the next step to build on. Return ONLY a JSON object with a single `result` field containing your output. No prose, no backticks, no preamble.
```

**prompts/02_second.md**
```
You are the second step of a three-step linear flow.

The prior step's handoff is available in the context block above as `{{stepNames[0]}}`. Read it and extend the work.

Input:
- subject: {{input.subject}}
- prior output: {{{{stepNames[0]}}.result}}

Produce the next stage of the result. Return ONLY a JSON object with a single `result` field. No prose, no backticks, no preamble.
```

**prompts/03_third.md**
```
You are the final step of a three-step linear flow.

The prior step's handoff is available in the context block above as `{{stepNames[1]}}`. Read it and produce the final result.

Input:
- subject: {{input.subject}}
- prior output: {{{{stepNames[1]}}.result}}

Produce the final result. Return ONLY a JSON object with a single `result` field. No prose, no backticks, no preamble.
```

**README.md**
```markdown
# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

A three-step linear flow: `{{stepNames[0]}}` runs first, then `{{stepNames[1]}}` reads its handoff, then `{{stepNames[2]}}` reads the second step's handoff and produces the final result. Edit the prompts in `prompts/` and the input schema in `flow.ts` to adapt the flow to your task.

## Sample output

Each step emits a JSON handoff with a `result` field. The final handoff is named `{{stepNames[2]}}` and its shape matches the last prompt's contract. Add a screenshot or transcript excerpt to `examples/` once you have a real run.

## Estimated cost and duration

- **Cost:** $0.05–$0.30 per run on the default sonnet model (billed to your subscription on Pro/Max).
- **Duration:** 2–10 minutes depending on prompt length and model choice.

Update these numbers after your first few runs — the CLI prints actuals.

## Install

```bash
relay install {{pkgName}}
```

## Run

```bash
relay run {{pkgName}} --subject="your subject here"
```

## Configuration

The flow accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `subject` | `string` | (required) | The subject the flow operates on. |

Models per step (override via `relay run {{pkgName}} --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `{{stepNames[0]}}` | `sonnet` |
| `{{stepNames[1]}}` | `sonnet` |
| `{{stepNames[2]}}` | `sonnet` |

## Customization

Fork the flow:

```bash
relay install {{pkgName}}
mv ./.relay/flows/{{pkgName}} ./my-fork
cd ./my-fork
```

Then edit `prompts/`, `flow.ts`, or add schemas under `schemas/`. Common customizations:

- **Swap the model** — set `model: 'opus'` on a step in `flow.ts`.
- **Tighten each handoff** — add a Zod schema under `schemas/` and pass it via `output.schema` on each step.
- **Add a fourth step** — copy one of the existing steps, wire `dependsOn` and `contextFrom` to the prior step's handoff name.

## License

MIT. Copyright Ganderbite.
```

---

### §7.3 — fan-out

**File tree:**
```
<flow-name>/
├── package.json
├── tsconfig.json
├── flow.ts
├── prompts/
│   ├── 01_prep.md
│   ├── 02_branch_a.md
│   ├── 03_branch_b.md
│   └── 04_merge.md
└── README.md
```

**package.json**
```json
{
  "name": "{{pkgName}}",
  "version": "0.1.0",
  "description": "A Relay flow with a fan-out / fan-in topology.",
  "type": "module",
  "main": "./dist/flow.js",
  "files": [
    "dist",
    "prompts",
    "schemas",
    "templates",
    "examples",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "test": "relay test ."
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "relay": {
    "flowName": "{{pkgName}}",
    "displayName": "{{pkgName}}",
    "tags": [
      "fan-out",
      "parallel"
    ],
    "estimatedCostUsd": {
      "min": 0.05,
      "max": 0.25
    },
    "estimatedDurationMin": {
      "min": 3,
      "max": 10
    },
    "audience": [
      "dev"
    ]
  }
}
```

**tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": ".",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["flow.ts", "schemas/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

**flow.ts**
```typescript
import { defineFlow, step, z } from '@ganderbite/relay-core';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Fan-out / fan-in flow: prep → two parallel branches → merge.',
  input: z.object({
    topic: z.string().describe('The subject both branches analyze'),
  }),
  start: 'prep',
  steps: {
    prep: step.prompt({
      promptFile: 'prompts/01_prep.md',
      output: { handoff: 'prep' },
    }),
    branch_a: step.prompt({
      promptFile: 'prompts/02_branch_a.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { handoff: 'branch_a' },
    }),
    branch_b: step.prompt({
      promptFile: 'prompts/03_branch_b.md',
      dependsOn: ['prep'],
      contextFrom: ['prep'],
      output: { handoff: 'branch_b' },
    }),
    barrier: step.parallel({
      branches: ['branch_a', 'branch_b'],
      dependsOn: ['branch_a', 'branch_b'],
    }),
    merge: step.prompt({
      promptFile: 'prompts/04_merge.md',
      dependsOn: ['barrier'],
      contextFrom: ['prep', 'branch_a', 'branch_b'],
      output: { artifact: 'merged.md' },
    }),
  },
});
```

**prompts/01_prep.md**
```
You are preparing shared context for two downstream analyses. The topic is
`{{input.topic}}`.

Your job is to extract the facts both downstream branches will need so
neither branch has to redo the same legwork. Keep the output neutral and
structured — both branches will read it verbatim.

Produce a JSON object with these fields:

- `topic` — echo `{{input.topic}}` back.
- `summary` — one paragraph stating what is to be analyzed.
- `key_facts` — an array of short factual strings both branches will rely on.
- `open_questions` — an array of points neither branch can resolve alone.

Return ONLY the JSON object. No prose, no backticks, no preamble.
```

**prompts/02_branch_a.md**
```
You are the first of two parallel analysts. Your counterpart runs
simultaneously against the same prep handoff; do not attempt to coordinate
— your output will be merged in a later step.

Use the `{{prep}}` handoff as your source of truth. Focus on the first angle
of analysis for this template — replace this prompt with your own framing
when you fork the flow.

Produce a JSON object with these fields:

- `angle` — the label of the analysis perspective (for example, `risks`).
- `findings` — an array of objects, each `{ claim: string, evidence: string }`.
- `confidence` — one of `low`, `medium`, `high`.

Return ONLY the JSON object. No prose, no backticks, no preamble.
```

**prompts/03_branch_b.md**
```
You are the second of two parallel analysts. Your counterpart runs
simultaneously against the same prep handoff; do not attempt to coordinate
— your output will be merged in a later step.

Use the `{{prep}}` handoff as your source of truth. Focus on the second
angle of analysis for this template — replace this prompt with your own
framing when you fork the flow.

Produce a JSON object with these fields:

- `angle` — the label of the analysis perspective (for example, `opportunities`).
- `findings` — an array of objects, each `{ claim: string, evidence: string }`.
- `confidence` — one of `low`, `medium`, `high`.

Return ONLY the JSON object. No prose, no backticks, no preamble.
```

**prompts/04_merge.md**
```
You are merging two parallel analyses into a single artifact. Both
branches ran against the same prep handoff; your job is to reconcile their
findings without losing signal from either side.

Use `{{prep}}`, `{{branch_a}}`, and `{{branch_b}}` to produce a Markdown
document with these sections:

1. **Topic** — restate the subject from the prep handoff.
2. **Branch A: {{branch_a.angle}}** — summarize every finding.
3. **Branch B: {{branch_b.angle}}** — summarize every finding.
4. **Agreements** — claims both branches support.
5. **Tensions** — claims that conflict, with one sentence per tension.
6. **Next steps** — concrete follow-ups informed by both branches.

Return the full Markdown document. No commentary before or after.
```

**README.md**
```markdown
# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

A Relay flow scaffolded from the `fan-out` template.

## What it does

Runs a fan-out / fan-in pipeline: one prep step produces shared context,
two analysis branches run concurrently against that context, and a final
merge step reconciles both branches into a single Markdown artifact.

```
prep ──▶ branch_a ─┐
     │             ├──▶ merge
     └─▶ branch_b ─┘
```

## Estimated cost and duration

- **Cost:** $0.05–$0.25 per run (billed to your subscription on Pro/Max).
- **Duration:** ~3–10 minutes depending on topic scope and model choice.

## Run

```bash
relay run . --topic="the subject to analyze"
```

## License

MIT.
```

---

### §7.4 — discovery

**File tree:**
```
<flow-name>/
├── package.json
├── tsconfig.json
├── flow.ts
├── prompts/
│   ├── 01_inventory.md
│   ├── 02_entities.md
│   ├── 03_services.md
│   └── 04_report.md
├── schemas/
│   ├── entities.ts
│   └── inventory.ts
└── README.md
```

**package.json**
```json
{
  "name": "{{pkgName}}",
  "version": "0.1.0",
  "description": "Explores a codebase and produces an HTML report.",
  "type": "module",
  "main": "./dist/flow.js",
  "files": [
    "dist",
    "prompts",
    "schemas",
    "templates",
    "examples",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "test": "relay test ."
  },
  "peerDependencies": {
    "@ganderbite/relay-core": "^1.0.0"
  },
  "relay": {
    "flowName": "{{pkgName}}",
    "displayName": "{{pkgName}}",
    "tags": [
      "discovery",
      "documentation",
      "audit"
    ],
    "estimatedCostUsd": {
      "min": 0.2,
      "max": 0.8
    },
    "estimatedDurationMin": {
      "min": 5,
      "max": 20
    },
    "audience": [
      "pm",
      "dev"
    ]
  }
}
```

**tsconfig.json**
```json
{
  "extends": "@ganderbite/relay-core/tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": false
  },
  "include": ["flow.ts", "schemas/**/*.ts"]
}
```

**flow.ts**
```typescript
import { defineFlow, step, z } from '@ganderbite/relay-core';
import { EntitiesSchema } from './schemas/entities.js';
import { InventorySchema } from './schemas/inventory.js';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Explores a codebase and produces an HTML report.',
  input: z.object({
    repoPath: z.string().describe('Absolute path to the repository to explore.'),
    audience: z
      .enum(['pm', 'dev', 'both'])
      .default('both')
      .describe('Who the report is written for.'),
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

**prompts/01_inventory.md**
```
You are taking inventory of the repository at `{{input.repoPath}}`.

Walk the tree. For every package (anything with a `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or equivalent manifest), record its path, its name, its primary language, and its entry points.

Use Glob to enumerate manifests. Use Read to inspect each one. Do not open source files unless a manifest leaves an entry point ambiguous.

Return ONLY a JSON object matching the InventorySchema. No prose, no backticks, no preamble.
```

**prompts/02_entities.md**
```
You are documenting the entities in a codebase for a {{input.audience}} audience.

The package inventory is in the `<context name="inventory">` block above.
Total packages: {{inventory.packages.length}}

For each package in `{{inventory.packages}}`, open its entry points and identify the top-level entities — models, services, controllers, and utilities. Skip dependencies and generated files. Summarize each entity in one sentence.

Return ONLY a JSON object matching the EntitiesSchema. No prose, no backticks, no preamble.
```

**prompts/03_services.md**
```
You are mapping the runtime services that tie the codebase together, for a {{input.audience}} audience.

The package inventory is in the `<context name="inventory">` block above.
Total packages: {{inventory.packages.length}}

For each package in `{{inventory.packages}}`, identify the external surfaces it exposes or consumes — HTTP endpoints, CLI commands, queues, databases, third-party APIs. Group related surfaces into named services. Note which packages own each service.

Return ONLY a JSON object with this shape:

{
  "services": [
    { "name": "...", "owner": "<package name>", "surface": "http|cli|queue|db|external", "summary": "..." }
  ]
}

No prose, no backticks around the top-level output, no preamble.
```

**prompts/04_report.md**
```
You are writing the final codebase report for a {{input.audience}} audience.

You have three context blocks above:

- `<context name="inventory">` — the package list ({{inventory.packages.length}} packages).
- `<context name="entities">` — models, services, controllers, utilities.
- `<context name="services">` — runtime surfaces grouped by service.

Produce a single self-contained HTML document with these six sections, in order:

1. **Overview** — two paragraphs, one for the {{input.audience}} reader, naming the repo and what it does.
2. **Packages** — a table of `{{inventory.packages}}` with path, language, and entry points.
3. **Entities** — grouped by `kind`, with file links.
4. **Services** — grouped by `surface`, with owner and summary.
5. **Dependencies between packages** — a short prose paragraph inferred from the inventory and entities.
6. **Open questions** — three bullet points the reader should follow up on.

Inline all CSS in a `<style>` block. No external assets. No JavaScript. The document must open correctly as a local file.

Return the full HTML document. No commentary, no backticks.
```

**schemas/inventory.ts**
```typescript
import { z } from '@ganderbite/relay-core';

export const InventorySchema = z.object({
  packages: z.array(
    z.object({
      path: z.string().describe('Repo-relative path to the package root.'),
      name: z.string().describe('The package name as declared in its manifest.'),
      language: z
        .enum(['ts', 'js', 'py', 'go', 'rust', 'other'])
        .describe('Primary language of the package.'),
      entryPoints: z.array(z.string()).describe('Repo-relative paths to the package entry points.'),
    }),
  ),
});

export type Inventory = z.infer<typeof InventorySchema>;
```

**schemas/entities.ts**
```typescript
import { z } from '@ganderbite/relay-core';

export const EntitiesSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe('The entity identifier (class, function, type).'),
      kind: z
        .enum(['model', 'service', 'controller', 'util'])
        .describe('The architectural role the entity plays.'),
      file: z.string().describe('Repo-relative path to the file that defines it.'),
      summary: z.string().describe('One-sentence description of what the entity does.'),
    }),
  ),
});

export type Entities = z.infer<typeof EntitiesSchema>;
```

**README.md**
```markdown
# {{pkgName}}

`●─▶●─▶●─▶●  {{pkgName}}`

## What it does

Reads a repository and produces a six-section HTML report describing the packages, entities, and runtime services inside it. Four steps, about five to twenty minutes per run, under one US dollar of estimated API-equivalent cost — billed to your Pro/Max subscription.

## Estimated cost and duration

- **Cost:** $0.20–$0.80 per run (estimated API equivalent; billed to your subscription on Pro/Max).
- **Duration:** ~5–20 minutes, depending on repository size.

## Run

```bash
relay run . <repo-path> [--audience=pm|dev|both]
```

The most common invocation, pointing the flow at the current directory:

```bash
relay run . .
```

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `repoPath` | `string` | (required) | Absolute path to the repository. |
| `audience` | `enum` | `both` | One of `pm`, `dev`, `both`. Tunes the report prose. |

## License

MIT. Copyright Ganderbite.
```
