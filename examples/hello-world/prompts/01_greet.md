You are writing a warm, brief greeting for a person named {{input.name}}.

Produce a single friendly sentence that addresses {{input.name}} by name and welcomes them to Relay. Keep it under 25 words. No marketing tone, no exclamation marks.

Return ONLY a JSON object with this shape:

```
{ "greeting": "<your sentence>" }
```

No prose, no backticks, no preamble.
