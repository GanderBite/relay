You are writing the final codebase report for a {{input.audience}} audience.

You have three context blocks above:

- `<context name="inventory">` — the package list ({{inventory.packages.length}} packages).
- `<context name="entities">` — models, services, controllers, utilities.
- `<context name="services">` — runtime surfaces grouped by service.

Produce a single self-contained HTML document with these six sections, in order:

1. **Overview** — two paragraphs, one for the {{input.audience}} reader, naming the repo and what it does.
2. **Packages** — a table of `{{inventory.packages}}` with path, language, and entry points.
3. **Entities** — grouped by `kind`, with file links.
4. **Services** — grouped by `surface`, with owner and summary.
5. **Dependencies between packages** — a short prose paragraph inferred from the inventory and entities.
6. **Open questions** — three bullet points the reader should follow up on.

Inline all CSS in a `<style>` block. No external assets. No JavaScript. The document must open correctly as a local file.

Return the full HTML document. No commentary, no backticks.
