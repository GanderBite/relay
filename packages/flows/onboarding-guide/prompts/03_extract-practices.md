You are extracting the development practices used in this project.

The project scan index is in `<context name="scan">`. The module map is in `<context name="explore">`. The project root is `{{input.projectDir}}`.

Use Read, Grep, and Bash to inspect actual files — do not rely on the scan index alone.

Extract all of the following:

- **Architecture** — the dominant pattern name (MVC, hexagonal, clean, layered, event-driven, or other), its layer names, and which modules from `{{explore.modules}}` implement each layer.
- **Git commit format** — read `.commitlintrc*` files; if absent, read the file at `{{scan.contributingGuidePath}}` (skip if empty). State the exact format string or convention verbatim.
- **Merge strategy** — squash, rebase, or merge; read `.github/` settings or the contributing guide.
- **Branch naming** — the convention from contributing docs or CI branch filters.
- **Error handling** — how errors are represented and propagated (throw, Result type, error events); name the pattern and the repo-relative path of the file where it is canonically defined.
- **Testing** — the framework, test file layout (co-located vs separate `tests/` directory), and coverage target if stated.
- **Documentation conventions** — how code is documented (JSDoc, inline comments, separate docs site, ADRs).
- **CI/CD** — read each file listed in `{{scan.ciFilePaths}}`; summarise what jobs run on push and what must pass before a merge is allowed.
- **Local setup** — read the file at `{{scan.readmePath}}` and extract the exact, ordered sequence of commands a developer runs to get the project working locally.
- **Gotchas** — anything in the docs or source flagged as a common mistake, footgun, or non-obvious constraint.

Return ONLY a JSON object with this shape:

{
  "architecturePattern": { "name": "...", "layers": [{ "name": "...", "modules": ["..."] }] },
  "gitConventions": { "commitFormat": "...", "mergeStrategy": "...", "branchNaming": "..." },
  "errorHandling": { "pattern": "...", "canonicalFile": "..." },
  "testing": { "framework": "...", "layout": "co-located|separate", "coverageTarget": "..." },
  "documentationConvention": "...",
  "ciCdPipeline": { "onPush": ["..."], "requiredToMerge": ["..."] },
  "localSetup": { "prerequisites": ["..."], "steps": ["..."] },
  "gotchas": ["..."]
}

No prose, no backticks, no preamble.
