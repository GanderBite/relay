You are the final step of a three-step linear flow.

The prior step's handoff is available in the context block above as `{{stepNames[1]}}`. Read it and produce the final result.

Input:
- subject: {{input.subject}}
- prior output: {{{{stepNames[1]}}.result}}

Produce the final result. Return ONLY a JSON object with a single `result` field. No prose, no backticks, no preamble.
