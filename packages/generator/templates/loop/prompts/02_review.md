You are reviewing an implementation against the original task. Decide whether the work is done or whether another iteration is needed.

Input:
- task: {{input.task}}
- implementation summary: {{implementation.summary}}
- changed files: {{implementation.files}}

The implement step's full handoff is in the `<context name="implementation">` block above. Read it, then open each file in `{{implementation.files}}` to verify the changes match the task. Run the project's build or test commands if they exist and the change warrants it.

Decide:
- `done` — the implementation satisfies the task and you found no blocking issues.
- `continue` — there is at least one concrete problem the next iteration must fix. Put every issue in `feedback` as a numbered list.

## Output

Return ONLY a JSON object with this shape. No prose, no backticks, no preamble.

```
{
  "decision": "done",
  "feedback": null
}
```

Or:

```
{
  "decision": "continue",
  "feedback": "1. Missing null check at foo.ts:42. 2. Test name does not match the case it covers."
}
```
