You are the first of two parallel analysts. Your counterpart runs
simultaneously against the same prep baton; do not attempt to coordinate
— your output will be merged in a later runner.

Use the `{{prep}}` baton as your source of truth. Focus on the first angle
of analysis for this template — replace this prompt with your own framing
when you fork the race.

Produce a JSON object with these fields:

- `angle` — the label of the analysis perspective (for example, `risks`).
- `findings` — an array of objects, each `{ claim: string, evidence: string }`.
- `confidence` — one of `low`, `medium`, `high`.

Return ONLY the JSON object. No prose, no backticks, no preamble.
