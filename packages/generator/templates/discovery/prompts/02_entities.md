You are documenting the entities in a codebase for a {{input.audience}} audience.

The package inventory is in the `<context name="inventory">` block above.
Total packages: {{inventory.packages.length}}

For each package in `{{inventory.packages}}`, open its entry points and identify the top-level entities — models, services, controllers, and utilities. Skip dependencies and generated files. Summarize each entity in one sentence.

Return ONLY a JSON object matching the EntitiesSchema. No prose, no backticks, no preamble.
