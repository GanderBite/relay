# Prompt Engineering Reference for Relay Flows

Rules for writing `prompts/*.md` files in Relay flow packages. Every prompt the generator emits must follow these patterns.

---

## §1 — XML Structure for Claude Agent Prompts

Use XML as the structural skeleton when writing prompts that Claude agents execute. Tags are semantic boundaries, not decoration.

| Tag | Purpose | Use when |
|---|---|---|
| `<role>` | Who the agent is; identity, expertise, decision authority | Always |
| `<context>` | Background the agent needs before acting | Background cannot be inferred from role |
| `<job>` | What the agent produces; the deliverable | Always |
| `<rules>` | Hard constraints; non-negotiable boundaries | Rejection criteria are non-obvious |
| `<validation>` | Binary checks before the agent reports done | Output must pass specific conditions |
| `<output_format>` | Exact shape of output; show as template, not description | Output must match a specific schema |
| `<examples>` | Good/bad annotated output pairs | Format is hard to describe in prose alone |

Relay `prompts/*.md` files are usually short enough that full XML structure is unnecessary. Use it when a step has complex routing logic or multi-part output. For standard handoff-writing steps, prose is fine — provided it follows the role, job, and output contract patterns below.

---

## §2 — Role Design Rules

1. Open with an active verb naming what the agent does: "You are documenting..." or "You are mapping..." — not "You are a helpful assistant."

2. Specify audience when it changes the prose: "You are writing the report for a `{{input.audience}}` audience." changes tone; "You are taking inventory" does not need audience context.

3. Name what the agent has access to: "The inventory is in the `<context name='inventory'>` block above." Never say "the prior step's output" — use the exact handoff id.

4. One role per prompt file. Do not ask one step to do two independent things.

5. Thirty lines is the practical maximum for a prompt that writes a JSON handoff. Longer prompts are two prompts.

---

## §3 — Output Contract Phrases

End every prompt with the exact phrase matching its output type. These are not suggestions — partial contracts cause parsers to receive preamble or commentary mixed into JSON.

| Output type | Closing phrase |
|---|---|
| JSON handoff (unvalidated) | `Return ONLY a JSON object with this shape: { ... }. No prose, no backticks, no preamble.` |
| JSON handoff (schema-validated) | `Return ONLY a JSON object matching the <SchemaName>. No prose, no backticks, no preamble.` |
| Markdown artifact | `Return the full Markdown document. No commentary before or after.` |
| HTML artifact | `Return the full HTML document. No commentary, no backticks.` |
| Plain text artifact | `Return ONLY the <noun>. No preamble, no headings, no commentary.` |

"No backticks" alone is a partial contract. Always pair it with "No prose, no preamble."

---

## §4 — Context Reference Convention

Reference injected handoffs by their exact id. Never write "the context above" or "the prior step's output."

| Syntax | Resolves to |
|---|---|
| `{{handoffId}}` | Full handoff value (JSON or text) |
| `{{handoffId.fieldName}}` | Named field on a JSON handoff |
| `{{handoffId.array.length}}` | Length of an array field |
| `{{input.fieldName}}` | Flow-level input field |

When a step consumes two handoffs:
```
Use `{{prep}}`, `{{branch_a}}`, and `{{branch_b}}` to produce...
```

Reference specific fields:
```
The prep handoff's key facts are in `{{prep.key_facts}}`.
Branch A's angle is `{{branch_a.angle}}`.
```

---

## §5 — Imperative Language and Banned Phrases

Every instruction in a prompt must be imperative. The agent is being directed, not invited.

| Banned | Replace with |
|---|---|
| "consider" | name the specific action |
| "might" / "could" / "you may" | require it, or omit it entirely |
| "try to" | state the requirement directly |
| "feel free to" | drop it |
| "if possible" | state the condition explicitly or remove the instruction |
| "as appropriate" | define what qualifies |
| "etc." | list all items or say "including but not limited to: X, Y, Z" |
| "be thorough" | specify: "cover every package in the inventory" |

Every instruction must pass the "could two people interpret this differently?" test. If yes, it is too vague — replace with the specific action, file, or field name.

---

## §6 — Schema Design (When to Extract to schemas/)

**Extract to `schemas/<name>.ts`** when:
- The schema is referenced in more than one step's `output.schema`
- The schema has more than five fields
- The prompt body names the schema by class name ("matching the InventorySchema")

**Keep inline in `flow.ts`** when:
- Five or fewer fields, used by exactly one step, not named in the prompt body

Schema field discipline:
- Every field gets `.describe()` — the description appears in error messages and catalog UI
- Use `.enum()` for controlled vocabularies, not `z.string()` with a prose instruction in the prompt
- Use `.default()` for inputs with sensible defaults; the CLI marks them optional in help output

Schema file header (for extracted schemas):
```typescript
import { z } from '@relay/core';

export const <Name>Schema = z.object({ ... });
export type <Name> = z.infer<typeof <Name>Schema>;
```

---

## §7 — Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| Prompt over 30 lines that writes a JSON handoff | Model likely to include commentary or misformat JSON | Split into two steps: one to collect, one to format |
| "Do not include backticks" without "No preamble" | Partial contract; model returns clean JSON wrapped in prose | Always use the full closing phrase from §3 |
| `{{input.*}}` for values that should be in a handoff | Inputs are flow-wide; using them in mid-flow steps couples steps to the original input shape | Pass data forward through handoffs, not through input re-reads |
| Asking two parallel branches to coordinate | Parallel branches cannot communicate; they run in isolation | Put coordination logic in the merge step that reads both handoffs |
| Describing output format in prose instead of showing it | Model infers a different structure | Show the exact JSON shape: `{ "field": "..." }` |
| Role says "helpful assistant" | Agent defaults to generic behavior, hedges every claim | Use verb-object form: "You are mapping runtime services for a {{input.audience}} audience." |
| Implicit sequencing in a single prompt | Model may do steps out of order | Use numbered list for ordered steps, or split into separate prompt steps |
