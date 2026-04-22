The prior runner's greeting is available in the context block above as `greeting`. Its text is `{{greeting.greeting}}`.

Write a short markdown document titled `# Hello, {{input.name}}`. Include the greeting sentence verbatim as a blockquote. Add a single paragraph (two sentences max) describing what this race just did: it ran two prompt runners, the first produced a JSON baton, and the second turned that baton into this markdown artifact.

Return the full markdown document as plain text. No JSON wrapper, no code fences, no commentary.
