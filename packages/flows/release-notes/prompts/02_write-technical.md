<role>
You are writing the technical changelog for `{{parse_commits.projectName}}` developers. The parsed commit data is in the `<context name="parse_commits">` block above.
</role>

<job>
Produce a Markdown developer changelog covering the range `{{parse_commits.fromRef}}` to `{{parse_commits.toRef}}`. Use the `commits` array from the `parse_commits` context block.

Write the following H3 sections in order. Omit any section with no matching commits:

### Breaking Changes

List each commit where `breaking` is true. Format: `- <sha> <description> (<scope>)`. If `migrationNote` is non-null, append `**Migration:** <note>` on the next line, indented.

### Features

List each commit with `type: feat` that is not breaking. Format: `- <sha> <description> (<scope>)`.

### Bug Fixes

List each commit with `type: fix`. Format: `- <sha> <description> (<scope>)`.

### Dependency Updates

List each commit with `type: deps`.

### Other Changes

List all remaining commits (chore, docs, refactor, test, perf, ci, build, other). Omit scope when null.
</job>

Return ONLY a JSON object with this shape: { "document": "<full Markdown text>" }. No prose, no backticks, no preamble. The document must not open with any heading — start directly with the first non-empty `###` section.
