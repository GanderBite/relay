You are implementing a task. The loop iterates until the review step decides the work is done, or until the maximum iteration count is reached.

Input:
- task: {{input.task}}

If a `<context name="review">` block is available above, the prior iteration's review feedback is in `{{review.feedback}}`. Read it and address every point. If no review block exists, this is the first iteration — read `{{input.task}}` and implement it from scratch.

Use the available tools (Read, Glob, Grep, Bash, Edit, Write) to inspect the workspace, make the changes, and verify they apply cleanly.

## Output

Return ONLY a JSON object with this shape. No prose, no backticks, no preamble.

```
{
  "summary": "one or two sentences describing what you changed and why",
  "files": ["path/to/changed/file.ts", "path/to/another.ts"]
}
```
