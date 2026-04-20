You are enumerating every package in the repository at `{{input.repoPath}}` for a `{{input.audience}}` audience. Produce a JSON object matching the InventorySchema.

Use Read, Glob, and Grep to discover packages. Good starting points:

- `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, or a root `package.json` with a `workspaces` field for JS/TS monorepos.
- `go.work`, `Cargo.toml` workspace section, `pyproject.toml`, `pom.xml`, or `build.gradle` for other ecosystems.
- If none are present, treat each top-level directory that contains a manifest file (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.) as a package.

For each package, record:

- `path`: the directory relative to the repository root, e.g. `packages/core`.
- `name`: the package's published or declared name (from its manifest). Fall back to the directory name if no manifest is present.
- `language`: the primary source language. Exactly one of the following enum values — no other strings are valid:
  - `ts` for TypeScript or JavaScript packages.
  - `py` for Python packages.
  - `go` for Go packages.
  - `rust` for Rust packages.
  - `other` for every other language (Java, Kotlin, Ruby, C#, Swift, etc.).
- `entryPoints`: the files a reader should open first — main/bin entries from the manifest, plus any `index.*` or `src/index.*`. Paths are relative to the package directory. Include between 1 and 5 per package.

Be thorough but do not invent packages. If a directory looks like an app or library but has no manifest, still include it with `name` set to the directory name.

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "packages": [
    {
      "path": "packages/core",
      "name": "@relay/core",
      "language": "ts",
      "entryPoints": ["src/index.ts"]
    }
  ]
}
```
