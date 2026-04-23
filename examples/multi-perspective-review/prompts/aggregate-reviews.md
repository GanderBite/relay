You are merging three independent reviews of the file at `{{input.filePath}}` into a single report for the author.

The three reviewer handoffs are injected above as context blocks:

- `security` — security reviewer's JSON handoff. Overall severity is `{{security.severity}}`, with summary `{{security.summary}}`.
- `performance` — performance reviewer's JSON handoff. Overall severity is `{{performance.severity}}`, with summary `{{performance.summary}}`.
- `readability` — readability reviewer's JSON handoff. Overall severity is `{{readability.severity}}`, with summary `{{readability.summary}}`.

Each handoff has a `findings` array. Combine them into one markdown document with this shape:

```
# Review: <basename of filePath>

## Overall assessment

<two or three sentences that weigh the three reviews against each other and call out the highest-severity perspective>

## Security (severity: <value>)

<one-paragraph summary, then a bullet list of findings in "location — issue — recommendation" form; write "No findings." if the array is empty>

## Performance (severity: <value>)

<same shape as the Security section>

## Readability (severity: <value>)

<same shape as the Security section>

## Top priorities

<ordered list of at most five items, drawn from the highest-severity findings across all three perspectives, in the order the author should address them>
```

Return the full markdown document as plain text. No JSON wrapper, no code fences around the whole document, no commentary before or after.
