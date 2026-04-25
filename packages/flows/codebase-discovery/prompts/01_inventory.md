You are documenting a codebase for a `{{input.audience}}` audience. Produce a JSON object matching the InventorySchema.

## Step 1 — pre-scan the repository

Run this command using the Bash tool to get the package list pre-computed:

```
node {{flowDir}}/dist/scripts/scan-packages.js {{input.repoPath}}
```

The script scans every `package.json` (excluding `node_modules` and `dist`) and outputs a JSON object in the InventorySchema shape.

## Step 2 — verify and enrich

For each package in the script output:

- Use Read or Glob to confirm the `entryPoints` listed are real files. Add any significant entry points the script missed (e.g. `bin/`, a secondary CLI entry, a `testing/index.ts`).
- Correct the `language` if wrong (the script infers from `tsconfig.json` presence and file extensions).
- Keep the `path` and `name` as the script reported them unless you find a genuine error.

Do not invent packages. Only include packages that `package.json` files confirm exist.

## Output

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "packages": [
    {
      "path": "packages/core",
      "name": "@relay/core",
      "language": "ts",
      "entryPoints": ["src/index.ts", "src/testing/index.ts"]
    }
  ]
}
```
