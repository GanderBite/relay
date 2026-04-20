You are preparing shared context for two downstream analyses. The topic is
`{{input.topic}}`.

Your job is to extract the facts both downstream branches will need so
neither branch has to redo the same legwork. Keep the output neutral and
structured — both branches will read it verbatim.

Produce a JSON object with these fields:

- `topic` — echo `{{input.topic}}` back.
- `summary` — one paragraph stating what is to be analyzed.
- `key_facts` — an array of short factual strings both branches will rely on.
- `open_questions` — an array of points neither branch can resolve alone.

Return ONLY the JSON object. No prose, no backticks, no preamble.
