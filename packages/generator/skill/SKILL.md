---
name: relay-generator
description: Scaffold a new Relay flow package — name the flow, pick a template (blank, linear, fan-out, or discovery), elicit high-level steps, choose a model per step, and write a valid flow package to disk. Trigger when the user says "scaffold a new relay flow", "/relay-new", "generate a pipeline for ...", "new relay flow", or asks to create a Relay flow from a natural-language description. Uses Read, Write, AskUserQuestion, and Bash. Does not build the core library and does not run flows — it only emits a directory matching the Relay Flow Package format.
tools: Read, Write, AskUserQuestion, Bash
---

# Relay Generator

Scaffold a new Relay flow package. A flow package is a small, self-contained directory matching the §7 Flow Package format that compiles and runs on `@relay/core` without further editing.

This skill walks the user through five steps, then calls the scaffold CLI to write the files.

## Triggers

- "scaffold a new relay flow"
- "/relay-new" (with or without a description)
- "generate a pipeline for ..."
- "new relay flow"

If the user's phrasing matches any of the above, enter the protocol below. Do not invent flow files by hand — always call the scaffold CLI at the end so the generated package matches the canonical shape the orchestrator expects.

## Protocol

### Step 1 — Name the flow

Ask the user for a flow name. The name MUST be kebab-case (`^[a-z][a-z0-9-]*[a-z0-9]$`) — lowercase letters, digits, and hyphens, starting with a letter.

Use `AskUserQuestion`:

> What should this flow be called? (kebab-case, e.g. `codebase-discovery`)

Validate the answer. Reject and re-ask on:

- uppercase letters
- underscores, spaces, or other separators
- a leading digit or hyphen
- a trailing hyphen

Examples of valid names: `codebase-discovery`, `api-audit`, `migration-planner`, `my-flow`.

If the user's first phrasing is close but invalid (e.g. `CodebaseDiscovery`), offer the kebab-case form back and ask them to confirm.

### Step 2 — Pick a template

Four templates ship with the generator. Match the user's described intent against the templates first; only fall back to `AskUserQuestion` when the intent is ambiguous.

| Template | Shape | When to pick it |
|---|---|---|
| `blank` | one prompt step | the user wants a near-empty starting point and will fill in the steps themselves |
| `linear` | N prompt steps in series | the user described a straight sequence of steps (A feeds B feeds C) |
| `fan-out` | prep · parallel branches · merge | the user described two or more independent branches that later merge |
| `discovery` | modeled on `codebase-discovery` | the user described reading a codebase or repo and producing a structured report |

If the user's first message already names a topology ("I want a linear four-step flow", "fan it out into two branches", "something like codebase-discovery"), pick the template directly and confirm with one sentence: "Using the `linear` template — four steps in series."

Otherwise, ask:

> Which topology fits your flow?
>
>  · blank     · one step · fill it in yourself
>  · linear    · N steps in series
>  · fan-out   · prep, then parallel branches, then merge
>  · discovery · modeled on codebase-discovery (inventory → entities + services → report)

### Step 3 — Elicit the high-level steps

For `blank` and `discovery`, the step set is fixed by the template and this step is skipped — just confirm the template's default step names with the user.

For `linear` and `fan-out`, ask the user to name the steps. Keep it conversational, not a form:

> What are the steps? Give each a short kebab-case name. For `linear`, list them in order. For `fan-out`, give me the prep step, the parallel branch steps, and the merge step separately.

Validate each step name the same way as the flow name (kebab-case). Reject reserved names: `input`, `output`, `run`, `state`.

A flow must have at least one step and no more than 20 steps at scaffold time. If the user describes more than 20, ask whether the flow should be split into two.

### Step 4 — Choose a model per step

Default every step to `sonnet`. Ask once:

> Default every step to sonnet? (yes / no — answering no lets you pick per step)

If the user says yes, set every step to `sonnet` and move on. If the user says no, walk through the step list and use `AskUserQuestion` per step:

> Model for step `<name>`?
>
>  · sonnet (default)
>  · opus
>  · haiku

Do not offer other model names. The three above are the Relay-supported set at scaffold time. The user can edit `flow.ts` later to change the model string.

### Step 5 — Write the files

Hand the collected inputs to the scaffold CLI. The CLI copies the selected template directory into `./<flow-name>/` and substitutes tokens (`{{pkgName}}`, step names, model names).

Run it via `Bash`:

```bash
node ~/.claude/skills/relay-generator/dist/cli.js \
  --template <blank|linear|fan-out|discovery> \
  --out ./<flow-name> \
  --token pkgName=<flow-name> \
  --token "stepNames[0]=<first-step>" \
  --token "stepNames[1]=<second-step>" \
  --token "stepNames[2]=<third-step>"
```

The scaffold CLI is the single source of truth for the token-substitution rules. Do not write the files yourself with `Write` — the CLI enforces the §7.1 layout and catches token typos at scaffold time.

After the CLI reports success, print a short next-step block for the user:

```
 ✓ wrote ./<flow-name>/package.json
 ✓ wrote ./<flow-name>/flow.ts
 ✓ wrote ./<flow-name>/prompts/...
 ✓ wrote ./<flow-name>/README.md

try it:
    cd <flow-name> && relay run .
```

## Output contract (§7.1 directory layout)

Every flow package the scaffolder emits has this shape:

```
<flow-name>/
├── package.json         # name, version, dep on @relay/core
├── flow.ts              # the defineFlow() entry point — default export
├── prompts/
│   ├── 01_<step>.md
│   ├── 02_<step>.md
│   └── ...
├── schemas/             # optional: shared Zod schemas
│   └── <name>.ts
├── templates/           # optional: output templates (HTML, markdown)
│   └── <name>.<ext>.ejs
├── examples/            # optional: sample outputs for the README
│   └── sample-output.<ext>
├── README.md            # user-facing docs (see §7.4)
└── tsconfig.json        # extends @relay/core/tsconfig
```

The generated `package.json` includes the `relay` metadata block (`displayName`, `tags`, `estimatedCostUsd`, `estimatedDurationMin`, `audience`) with placeholder values the user edits later. The generated `README.md` includes the §7.4 ordered sections 1–5 so the flow can be published to the catalog without further edits.

For the full contract, see the `flow-package-format` skill.

## What this skill does NOT do

Mirrors product spec §6.3.

- Does not build or modify `@relay/core`. It only emits flow packages.
- Does not run the flow. That is the `relay run` command in `@relay/cli`.
- Does not install dependencies. The user runs `pnpm install` (or `npm install`) inside the new directory after scaffolding.
- Does not have its own runtime. It uses Claude Code's `Read`, `Write`, `AskUserQuestion`, and `Bash` tools — and the bundled scaffold CLI — and nothing else.
- Does not edit existing flow packages. Use `Read`/`Write` directly for that.
- Does not publish to npm. That is the `relay publish` command.

## Voice and copy rules

When you print status or error text to the user, follow the Relay voice rules.

- No emojis. Use the symbol vocabulary: `✓` done, `✕` failed, `⚠` warning, `·` separator, `○` pending.
- The word "simply" is banned.
- No trailing `!` on any line.
- Second person, present tense, active voice.
- State what happened; name the next command.

The mark `●─▶●─▶●─▶●` is the Relay signature — use it once, at the top of the final summary, if you print one.
