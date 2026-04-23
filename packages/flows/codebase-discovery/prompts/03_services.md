You are identifying cross-cutting services in the repository for a `{{input.audience}}` audience. Produce a JSON object listing the runtime concerns that span more than one package.

The package inventory is available as `{{inventory}}`. Walk `{{inventory.packages}}` and look for shared concerns such as:

- Authentication and authorization.
- Configuration and environment loading.
- Logging, telemetry, or metrics.
- Database access, ORMs, or schema migrations.
- Caching, queues, job scheduling, or background workers.
- HTTP clients, API gateways, or inter-service transport.
- State persistence (checkpoints, batons, atomic writes).
- Testing infrastructure (mocks, fixtures, harnesses shared across packages).
- Build, bundling, or code generation pipelines.

Use Read, Glob, and Grep to confirm each candidate is actually used in more than one package. Skip single-package concerns — those belong in the entities list, not here.

For each service, record:

- `name`: a short human name, e.g. `Auth guard`, `State store`, `Claude Agent SDK wrapper`.
- `description`: one sentence, 15–30 words, explaining what the service does and why it crosses package boundaries. Tune the wording for a `{{input.audience}}` reader.
- `usedBy`: an array of package names (matching `inventory.packages[*].name`) that depend on or participate in the service. At least two entries.

Return ONLY the raw JSON object in this shape. No prose, no markdown fences, no preamble.

```
{
  "services": [
    {
      "name": "Subscription auth guard",
      "description": "Prevents the Claude Agent SDK from silently routing tokens to a paid API account when the user is on a subscription plan.",
      "usedBy": ["@relay/core", "@relay/cli"]
    }
  ]
}
```
