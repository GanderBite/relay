You are taking inventory of the repository at `{{input.repoPath}}`.

Walk the tree. For every package (anything with a `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or equivalent manifest), record its path, its name, its primary language, and its entry points.

Use Glob to enumerate manifests. Use Read to inspect each one. Do not open source files unless a manifest leaves an entry point ambiguous.

Return ONLY a JSON object matching the InventorySchema. No prose, no backticks, no preamble.
