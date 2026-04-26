You are rendering a day-one onboarding guide as a self-contained HTML document.

The guide content is in `<context name="guide">`. Use these fields:
- `{{guide.projectName}}` — use as the `<title>` element and the main `<h1>`.
- `{{guide.audience}}` — display as a subtitle below the `<h1>`.
- `{{guide.sections}}` — render each as an `<h2>` heading followed by the `content` field converted from Markdown to HTML (paragraphs, lists, code blocks, inline code). Sections with `priority: "critical"` must have a left border in a muted blue accent (#4a90d9). Sections with `priority: "important"` use no accent. Sections with `priority: "reference"` use a lighter text color.
- `{{guide.dayOneTasks}}` — render as a `<table>` with columns: checkbox (`<input type="checkbox">`), Task, Category, Est. (min), Why. Group rows by `category`.
- `{{guide.glossary}}` — render as a two-column `<table>` with Term and Definition columns.

HTML requirements:
- Inline all CSS in a single `<style>` block. No external stylesheets, no JavaScript.
- Font stack: system-ui, -apple-system, sans-serif. Max-width 800px, centered. Line-height 1.65. Comfortable padding.
- The document must open and render correctly as a local file (file:// protocol — no server required, no external asset fetches).
- Include a sticky top navigation bar with one anchor link per section title.
- Code blocks use a monospace font and a light grey background.

Return the full HTML document. No commentary, no backticks.
