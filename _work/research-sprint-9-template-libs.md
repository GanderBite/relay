# Research: Template Engine for the Generator Scaffolder

**Sprint:** 9  
**Task:** task_108  
**Gates:** task_57, task_62  
**Date:** 2026-04-20

---

## Scope

`packages/generator/src/scaffold.ts` (task_62) must copy files from a template
directory into a user-specified `outDir`, replacing `{{token}}` placeholders
with values provided at scaffold time. This research locks the engine choice
before any template-substitution code is written.

---

## Token inventory (tasks 58–61)

Examining the four template tasks reveals the following substitution surface:

| Template | Tokens used |
|---|---|
| blank | `{{pkgName}}` |
| linear | `{{pkgName}}`, `{{stepNames[*]}}` (referenced in comments, no iteration in source files) |
| fan-out | `{{pkgName}}` (step names are hardcoded as prep/branch_a/branch_b/merge) |
| discovery | `{{pkgName}}` (step names are hardcoded per the canonical flow) |

The `linear` template description mentions `{{stepNames[*]}}` but the actual
template files are static Markdown and TypeScript — the placeholder appears in
comments and prompt prose, not in a loop construct that requires engine
iteration. The scaffolding logic itself (scaffold.ts) populates the step names
by string replacement into pre-written source lines, not by iterating a loop
inside a template.

**Conclusion:** Every template file needs only flat key→value substitution.
No conditional blocks, no `{{#each}}` loops, and no partial includes are
required by any of the four templates.

---

## Candidate evaluation

### (a) ejs

· **Verdict: rejected.**

`ejs` is introduced in sprint 11 (task_70) specifically to render a
self-contained HTML report inside `packages/flows/codebase-discovery/`. That
is a runtime rendering concern — Claude fills an HTML scaffold with structured
data at flow execution time. Using `ejs` here would conflate two distinct
layers: HTML report rendering (a flow concern) versus file scaffolding (a
generator concern). Adding `ejs` as a generator dependency would bleed a
flow-level dep into the generator package with no benefit, and the `<%=` /
`<%` syntax is mismatched to the `{{token}}` convention already established
by the template files in tasks 58–61.

### (b) handlebars

· **Verdict: available but unnecessary for the current token surface.**

`handlebars` is a direct dependency of `@relay/core` (confirmed in
`packages/core/package.json`: `"handlebars": "^4.7.8"`) and is used by
`packages/core/src/template.ts` to render prompt bodies at flow runtime.
`@relay/generator` does not list `@relay/core` as a dependency — it is a
separate package used only for installation and scaffolding. Pulling in
`handlebars` as a direct generator dep would add ~450 kB to a package whose
only current substitution need is flat key→value replacement. If any future
template requires conditionals or loops (e.g. generating optional sections
based on user choices), handlebars is the correct escalation path because it
is already present in the workspace's dependency graph and the project already
has working knowledge of its API via `renderTemplate` in core.

### (c) lodash.template

· **Verdict: rejected.**

`lodash.template` is CommonJS-first and carries the full lodash dependency
chain; the project is ESM-only (Node ≥ 20.10, `"type": "module"` throughout).
The `_.template` interpolation syntax (`<%= %>`) is also mismatched to the
`{{token}}` convention, requiring a custom delimiter configuration that adds
complexity for no gain.

### (d) Bespoke `{{token}}` regex replace

· **Verdict: recommended.**

A single `replaceAll`-based substitution loop over a `Record<string, string>`
is approximately 10–12 lines of code, introduces zero new dependencies, and
covers every token needed by all four templates. The `{{...}}` delimiter is
already present in the template source files (tasks 58–61) and matches
developer expectations set by the rest of the codebase. This approach is
trivially testable and carries no risk of template injection because the
scaffolder never executes user-supplied template logic — it only replaces
static string tokens.

---

## Recommendation

Use bespoke `{{token}}` regex replacement in `scaffold.ts`.

The implementation should:

1. Accept a `tokens: Record<string, string>` map.
2. For each file copied from the template directory, run a single pass replacing
   every `{{key}}` occurrence with its corresponding value.
3. Keys that are absent from the map should produce an `err()` result (missing
   required token) rather than silently emitting `{{key}}` in the output.

If a future template genuinely requires a conditional or iteration construct,
migrate the affected template to Handlebars at that point — the
`renderTemplate` helper in `@relay/core` is the model to follow, and
`handlebars` is already in the workspace dependency graph.

---

## Decision

**Engine:** bespoke `{{token}}` regex replace — zero new dependencies, ~10
lines, sufficient for every token the four sprint-9 templates require.

**ejs:** rejected — wrong layer (HTML report rendering is a flow concern, not
a generator concern); `<%` syntax conflicts with `{{` convention.

**handlebars:** not adopted now; named as the escalation path if any template
requires conditionals or loops in a future sprint.

**lodash.template:** rejected — CJS-first, mismatched syntax, unnecessary
weight.
