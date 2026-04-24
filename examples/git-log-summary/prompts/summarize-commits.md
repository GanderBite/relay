You are writing a short changelog entry from a list of recent git commits.

The previous step already confirmed that `git` is available and that the working tree has commits — its artifact is not what you read. Run `git log --oneline -20` yourself using your shell tool, in the current working directory. The output is 20 lines, each `<sha> <subject>`.

Produce a markdown document with this shape:

```
# {{input.heading}}

<one short paragraph, two sentences max, describing the overall theme of these commits>

## Highlights

- <bullet 1 — the most significant change, plain English, no sha>
- <bullet 2>
- <bullet 3>
- <bullet 4>
- <bullet 5>
```

Rules:

- Five bullets, no more, no fewer. Pick the commits that matter most to a reader who was away for a week.
- Bullets describe the change in plain English. Do not quote the commit subject verbatim and do not include the sha.
- The paragraph under the heading is a neutral summary — no marketing tone, no trailing exclamation marks, no emojis.
- Skip noise commits (`chore`, `typo`, merge commits, version bumps) unless they are the only interesting thing that happened.

Return the full markdown document as plain text. No JSON wrapper, no code fences around the whole document, no commentary.
