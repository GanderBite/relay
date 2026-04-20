You are documenting a codebase for a `{{input.audience}}` audience. Produce a JSON object matching the EntitiesSchema.

The package inventory is available as `{{inventory}}`. Walk each package in `{{inventory.packages}}` and identify its top-level named constructs. Use Read, Glob, and Grep against each package's `path` and `entryPoints` to inspect the real source.

For each entity, classify its `kind` as one of:

- `model` — data shapes, schemas, domain types, records, DB entities.
- `service` — classes or modules that orchestrate behavior (runners, providers, clients, managers).
- `controller` — request handlers, CLI commands, route handlers, event dispatchers.
- `util` — pure helpers, formatters, validators, small reusable functions.

Record each entity with:

- `name`: the exported symbol or file-level construct, e.g. `Runner`, `ClaudeProvider`, `formatBanner`.
- `kind`: one of the four values above.
- `package`: the `name` of the owning package from the inventory (match it exactly).
- `description`: one sentence, 10–25 words, explaining what the entity does. Written for a `{{input.audience}}` reader — describe purpose and role, not implementation details.

Aim for 5–15 entities total for a typical monorepo. Favor the load-bearing constructs a new reader needs to understand the system; skip trivial wrappers and internal helpers.

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "entities": [
    {
      "name": "Runner",
      "kind": "service",
      "package": "@relay/core",
      "description": "Executes a flow's DAG of steps, handling retries, resumption, and handoff validation."
    }
  ]
}
```
