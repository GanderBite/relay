You are mapping the runtime services that tie the codebase together, for a {{input.audience}} audience.

The package inventory is in the `<context name="inventory">` block above.
Total packages: {{inventory.packages.length}}

For each package in `{{inventory.packages}}`, identify the external surfaces it exposes or consumes — HTTP endpoints, CLI commands, queues, databases, third-party APIs. Group related surfaces into named services. Note which packages own each service.

Return ONLY a JSON object with this shape:

```
{
  "services": [
    { "name": "...", "owner": "<package name>", "surface": "http|cli|queue|db|external", "summary": "..." }
  ]
}
```

No prose, no backticks around the top-level output, no preamble.
