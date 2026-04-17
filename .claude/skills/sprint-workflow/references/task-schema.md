# Sprint Task Schema

Each task in a sprint's `waves[]` array has this exact shape:

```ts
type SprintTask = {
  id: string;              // "task_<N>" — globally unique across all sprints
  name: string;            // Short imperative title
  description: string;     // Multi-sentence body. References §X.Y spec sections.
  target_files: string[];  // Files this task creates or modifies. Repo-relative.
  depends_on: string[];    // Task IDs that must complete before this one starts.
  module: string;          // Dotted module path: "core", "core.flow", "cli.commands", etc.
  tags: string[];          // Free-form: "scaffolding", "foundation", "runner", "ux", "brand"
  risk: "low" | "medium" | "high";
};
```

## How to read each field

### `id`
Use it in the commit message footer: `Closes task_<N> from _work/sprint-<sprint>.json`.

### `name`
The `name` is the commit title (after the module prefix). Example commit subject:
```
core.runner: Runner scaffold and DAG walker (task_31)
```

### `description`
The contract. Read every sentence. Spec section references (`§4.9`) point at:
- `_specs/pipelinekit-tech_spec.md` for everything tech.
- `_specs/relay-product_spec.md` when prefixed with "product spec §X.Y".

The description usually names default values, error class to throw, type names, and the public API surface. Don't deviate.

### `target_files`
The complete list of files the task may touch. **If a task wants you to also touch a file not in this list, that's a sign the task is poorly scoped — flag it instead of silently expanding.** Common exception: a task may say "and re-export from `src/index.ts`" without listing index.ts; that's allowed.

### `depends_on`
Any IDs listed here must have shipped before this task can start. The orchestrator enforces wave ordering. As an agent, you can assume these task outputs exist on disk when you start.

### `module`
Dotted module path. Drives the agent picker:
- `core` / `core.*` → systems-engineer for runtime, task-implementer for foundation
- `cli` / `cli.*` → cli-ux-engineer (always, regardless of risk)
- `cli.catalog` → catalog-builder
- `flows.*` / `examples` / `generator.templates` → flow-author
- `docs` → doc-writer
- `catalog` → catalog-builder

### `tags`
Free-form classifiers. Useful tags to know:
- `scaffolding` — directory structure, package.json, tsconfig setup
- `foundation` — types, errors, utilities other code imports
- `runner`, `providers`, `runtime` — core runtime
- `dsl` — flow definition surface
- `cli`, `ux`, `brand` — user-visible
- `catalog`, `lint`, `publishing` — catalog plumbing
- `critical` — extra-careful review pass
- `security` — hits the auth/billing safety surface

### `risk`
- `low` — boilerplate, scaffolding, simple validation
- `medium` — non-trivial logic, but bounded scope
- `high` — load-bearing subsystems where a subtle bug compounds (Runner, ClaudeProvider, DAG, resume, abort, auth)

`risk: high` always routes to `systems-engineer` (or `cli-ux-engineer` for CLI tasks). Always merits a `code-reviewer` pass after.
