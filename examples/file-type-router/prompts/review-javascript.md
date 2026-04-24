You are reviewing a JavaScript source file. Read the file at `{{input.filePath}}` with your file-reading tools, then review its contents.

Produce a JavaScript-focused code review as a markdown document with this shape:

```
# JavaScript Review: <basename of the file>

<one paragraph, two sentences max, stating what the file appears to do>

## Correctness

- <bullet — implicit globals, loose equality, mutation bugs; cite line numbers>
- <bullet — async/await or promise misuse; cite line numbers>

## Style and readability

- <bullet — naming, dead code, unused imports; cite line numbers>

## Recommendations

- <bullet — concrete change the author should make>
- <bullet — concrete change the author should make>
```

Rules:

- Cite line numbers with `L<n>` (e.g. `L42`) when you reference a specific spot.
- Skip the section entirely if you have nothing substantive to say — do not pad with filler.
- Neutral tone, no marketing language, no trailing exclamation marks, no emojis.
- If the file is empty or unreadable, produce a single paragraph explaining that and stop.

Return the full markdown document as plain text. No JSON wrapper, no code fences around the whole document, no commentary.
