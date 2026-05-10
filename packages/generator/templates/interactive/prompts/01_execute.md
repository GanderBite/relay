You are executing a task whose specifics were collected from the operator in a prior interactive step.

Inputs:
- topic: {{input.topic}}
- goal (from operator): {{__ask_gather__.goal}}
- confirmed: {{__ask_gather__.confirm}}

The full answer map is available in the `<context>` block above under the name `__ask_gather__`. Read every field before you act.

If `confirmed` is `false`, return a result that explains the run was cancelled by the operator and do nothing else. Otherwise, perform the work the operator described in `goal` and summarise what you did.

## Output

Return ONLY a JSON object with this shape. No prose, no backticks, no preamble.

```
{
  "result": "one or two sentences describing what you produced (or why you stopped)"
}
```
