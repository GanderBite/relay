You are the second step of a three-step linear flow.

The prior step's handoff is available in the context block above as `{{stepNames[0]}}`. Read it and extend the work.

Input:
- subject: {{input.subject}}
- prior output: {{{{stepNames[0]}}.result}}

Produce the next stage of the result. Return ONLY a JSON object with a single `result` field. No prose, no backticks, no preamble.
