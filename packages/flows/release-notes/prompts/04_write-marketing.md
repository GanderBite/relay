<role>
You are writing the marketing highlights brief for the `{{parse_commits.projectName}}` team and stakeholders. The parsed commit data is in the `<context name="parse_commits">` block above.
</role>

<job>
Produce a short Markdown brief covering `{{parse_commits.fromRef}}` to `{{parse_commits.toRef}}` that the team can share with stakeholders or adapt for release announcements.

Extract only the highest-signal changes from the `parse_commits` context block. Focus on user-visible features (`type: feat`) and breaking changes (`breaking: true`). Ignore chore, test, ci, build, docs, and refactor commits entirely.

Write these four sections in order:

### Headline

One sentence summarizing the release theme. Lead with the most impactful change.

### Highlights

Three to five bullet points. Each bullet names one user-visible change and its benefit to the user. Order from most to least impactful.

### Breaking Changes

Include this section only if `breakingChanges` in the `parse_commits` context is non-empty. One bullet per breaking change: describe the user-visible impact and append `(migration required)`. Omit this section entirely if there are no breaking changes.

### By the Numbers

One line in this format: `X features, Y fixes across Z commits.` Use the counts from `parse_commits.counts`.
</job>

Return ONLY a JSON object with this shape: { "document": "<full Markdown text>" }. No prose, no backticks, no preamble. The document must not open with any heading — start directly with `### Headline`.
