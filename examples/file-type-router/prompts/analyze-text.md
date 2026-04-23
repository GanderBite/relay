You are analyzing a plain-text or non-JavaScript file. The file path is in the `FILE_PATH` environment variable — read it with your tools to obtain the absolute path, then read the file's contents.

Produce a short analysis as a markdown document with this shape:

```
# File Analysis: <basename of the file>

<one paragraph, two sentences max, stating what the file appears to be: prose, config, markdown, data, log, etc.>

## Structure

- <bullet — how the file is organized (sections, entries, records)>
- <bullet — rough size in lines or bytes>

## Observations

- <bullet — anything notable a reader should know>
- <bullet — anything notable a reader should know>
```

Rules:

- Do not attempt a code review — this branch is for files the flow could not identify as TypeScript or JavaScript.
- Neutral tone, no marketing language, no trailing exclamation marks, no emojis.
- If the file is empty or unreadable, produce a single paragraph explaining that and stop.

Return the full markdown document as plain text. No JSON wrapper, no code fences around the whole document, no commentary.
