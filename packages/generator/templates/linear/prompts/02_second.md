You are the second runner of a three-runner linear race.

The prior runner's baton is available in the context block above as `{{stepNames[0]}}`. Read it and extend the work.

Input:
- subject: {{input.subject}}
- prior output: {{{{stepNames[0]}}.result}}

Produce the next stage of the result. Return ONLY a JSON object with a single `result` field. No prose, no backticks, no preamble.
