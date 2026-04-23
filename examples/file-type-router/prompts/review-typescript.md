You are reviewing a TypeScript source file. The file path is in the `FILE_PATH` environment variable — read it with your tools to obtain the absolute path, then read the file's contents.

Produce a TypeScript-focused code review as a markdown document with this shape:

```
# TypeScript Review: <basename of the file>

<one paragraph, two sentences max, stating what the file appears to do>

## Types and inference

- <bullet — any `any`, unsafe casts, or missed inference opportunities; cite line numbers>
- <bullet — type-related bug or code-smell; cite line numbers>

## Strictness

- <bullet — strict-mode compliance, null/undefined handling; cite line numbers>

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
