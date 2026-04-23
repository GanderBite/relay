The prior step's greeting is available in the context block above as `greeting`. Its text is `{{greeting.greeting}}`.

Write a short markdown document titled `# Hello, {{input.name}}`. Include the greeting sentence verbatim as a blockquote. Add a single paragraph (two sentences max) describing what this flow just did: it ran two prompt steps, the first produced a JSON handoff, and the second turned that handoff into this markdown artifact.

Return the full markdown document as plain text. No JSON wrapper, no code fences, no commentary.
