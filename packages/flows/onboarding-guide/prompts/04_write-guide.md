You are writing a day-one onboarding guide for a new `{{input.audience}}` joining this project.

You have three context blocks:
- `<context name="scan">` — project scan index; `{{scan.projectName}}` is the project name.
- `<context name="explore">` — module map with bounded contexts and package dependencies.
- `<context name="practices">` — development practices, local setup steps, and gotchas.

Write sections appropriate for the `{{input.audience}}` role. Use the field references below as your primary sources — do not paraphrase or invent details not present in the context.

**developer**: produce sections for — local setup (copy `{{practices.localSetup.steps}}` verbatim as a numbered list), prerequisites (from `{{practices.localSetup.prerequisites}}`), architecture overview (from `{{practices.architecturePattern}}`), module map (one row per entry in `{{explore.modules}}` with path, bounded context, and summary), development practices (git commits from `{{practices.gitConventions.commitFormat}}`, merge strategy from `{{practices.gitConventions.mergeStrategy}}`, branch naming from `{{practices.gitConventions.branchNaming}}`, error handling from `{{practices.errorHandling}}`, testing from `{{practices.testing}}`), CI/CD (from `{{practices.ciCdPipeline}}`), gotchas (copy `{{practices.gotchas}}` verbatim as a bullet list), where to contribute first (infer from module summaries and documented good-first-issue guidance).

**pm**: produce sections for — product overview (read the file at `{{scan.readmePath}}` and summarise the first two sections), key user flows (infer end-to-end flows from module names and docs), data flow (from package dependencies in `{{explore.packageDependencies}}`), key constraints (technical and documented business constraints), glossary.

**qa**: produce sections for — testing strategy (from `{{practices.testing}}`), how to run tests (from `{{practices.localSetup.steps}}`), coverage expectations, CI checks that must pass (from `{{practices.ciCdPipeline.requiredToMerge}}`), gotchas (copy `{{practices.gotchas}}` verbatim).

**client**: produce sections for — what the product does and who it serves (read the file at `{{scan.readmePath}}` and extract the first paragraph), key features (infer from module summaries), how to get access (from `{{scan.envVarKeys}}` and setup docs), glossary.

For every audience: produce a `dayOneTasks` checklist with concrete actions ordered by urgency, and a `glossary` of terms a newcomer will encounter.

Set `projectName` to `{{scan.projectName}}` and `audience` to `{{input.audience}}`.

Return ONLY a JSON object in this exact shape. No prose, no backticks, no preamble.

{
  "audience": "developer",
  "projectName": "my-project",
  "sections": [
    {
      "title": "Local Setup",
      "content": "Markdown prose for this section.",
      "priority": "critical"
    },
    {
      "title": "Architecture Overview",
      "content": "Markdown prose for this section.",
      "priority": "important"
    },
    {
      "title": "Module Map",
      "content": "Markdown prose for this section.",
      "priority": "reference"
    }
  ],
  "dayOneTasks": [
    {
      "task": "Clone the repo and run pnpm install",
      "category": "setup",
      "estimatedMinutes": 10,
      "why": "Nothing works until dependencies are installed."
    },
    {
      "task": "Read the architecture overview section",
      "category": "read",
      "estimatedMinutes": 15,
      "why": "Understand the bounded contexts before touching code."
    }
  ],
  "glossary": [
    {
      "term": "Handoff",
      "definition": "A JSON object passed from one flow step to the next."
    }
  ]
}

Valid values for `priority`: "critical", "important", "reference".
Valid values for `category`: "setup", "read", "explore", "ask", "do".
`estimatedMinutes` must be a number, not a string.
