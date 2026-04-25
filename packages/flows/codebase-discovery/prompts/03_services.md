You are identifying cross-cutting services in the repository for a `{{input.audience}}` audience. Produce a JSON object listing runtime concerns that span more than one package.

The package inventory is available as `{{inventory}}`.

## Step 1 — pre-scan cross-package imports

Run this command using the Bash tool:

```
node {{flowDir}}/dist/scripts/find-cross-imports.js {{input.repoPath}}
```

The script greps import statements across all `.ts` source files and returns `{ crossPackageImports: [{ importedPackage, usedBy: string[] }] }` — listing every workspace package that is imported from at least one other workspace package, along with which packages import it.

## Step 2 — describe cross-cutting services

Work through the `crossPackageImports` list. For each entry where `usedBy` has 2 or more packages:

1. Use Read or Grep on the imported package's source to understand its purpose.
2. Identify the shared concern it represents: auth, logging, config, state persistence, testing infrastructure, build pipeline, transport, etc.
3. Write a `description`: one sentence, 15–30 words, explaining what it does and why it crosses package boundaries. Tune wording for a `{{input.audience}}` reader.
4. The `usedBy` array must contain package names matching `inventory.packages[*].name`.

Also check for concerns that are consumed at runtime but not caught by import scanning — for example, a shared config file, a test fixture directory, or a CLI tool used in scripts across packages. Include those if they are genuinely cross-cutting.

Skip concerns used by only one package.

## Output

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "services": [
    {
      "name": "Subscription auth guard",
      "description": "Prevents the Claude CLI provider from silently routing tokens to a paid API account when the user is on a subscription plan.",
      "usedBy": ["@relay/core", "@relay/cli"]
    }
  ]
}
```
