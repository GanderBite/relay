You are documenting a codebase for a `{{input.audience}}` audience. Produce a JSON object matching the EntitiesSchema.

The package inventory is available as `{{inventory}}`.

## Step 1 — pre-scan exported symbols

Run this command using the Bash tool:

```
node {{flowDir}}/dist/scripts/list-exports.js {{input.repoPath}}
```

The script greps for top-level `export class|function|const|interface|type|enum` declarations across all `.ts` source files (excluding `node_modules` and `dist`) and returns `{ exports: [{ name, file, exportKind }] }`.

## Step 2 — classify and describe

Work through the list from the script. For each exported symbol:

1. Confirm the file exists in one of the packages in `{{inventory.packages}}` (use the `file` field from the script). Skip symbols whose file is outside all listed packages.
2. Classify its `kind`:
   - `model` — data shapes, schemas, Zod types, domain records, DB entities
   - `service` — classes or modules that orchestrate behavior (runners, providers, clients, managers)
   - `controller` — request handlers, CLI commands, route handlers, event dispatchers
   - `util` — pure helpers, formatters, validators, small reusable functions
3. Use Read on the file to confirm purpose before writing the `summary`.
4. Write a `summary`: one sentence, 10–25 words, explaining what it does. Written for a `{{input.audience}}` reader.

Aim for 5–15 entities total. Favor load-bearing constructs a new reader needs; skip trivial wrappers and internal helpers.

## Output

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "entities": [
    {
      "name": "Orchestrator",
      "kind": "service",
      "file": "packages/core/src/orchestrator/orchestrator.ts",
      "summary": "Drives the execution of a compiled Flow's DAG, handling retries, resumption, and state persistence."
    }
  ]
}
```
