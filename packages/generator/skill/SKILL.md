---
name: relay-generator
description: Scaffold a new Relay race package — name the race, pick a template (blank, linear, fan-out, or discovery), elicit high-level runners, choose a model per runner, and write a valid race package to disk. Trigger when the user says "scaffold a new relay race", "/relay-new", "generate a pipeline for ...", "new relay race", or asks to create a Relay race from a natural-language description. Uses Read, Write, AskUserQuestion, and Bash. Does not build the core library and does not run races — it only emits a directory matching the Relay Race Package format.
tools: Read, Write, AskUserQuestion, Bash
---

# Relay Generator

Scaffold a new Relay race package. A race package is a small, self-contained directory matching the §7 Race Package format that compiles and runs on `@relay/core` without further editing.

This skill walks the user through five steps, then calls the scaffold CLI to write the files.

## Triggers

- "scaffold a new relay race"
- "/relay-new" (with or without a description)
- "generate a pipeline for ..."
- "new relay race"

If the user's phrasing matches any of the above, enter the protocol below. Do not invent race files by hand — always call the scaffold CLI at the end so the generated package matches the canonical shape the orchestrator expects.

## Protocol

### Step 1 — Name the race

Ask the user for a race name. The name MUST be kebab-case (`^[a-z][a-z0-9-]*[a-z0-9]$`) — lowercase letters, digits, and hyphens, starting with a letter.

Use `AskUserQuestion`:

> What should this race be called? (kebab-case, e.g. `codebase-discovery`)

Validate the answer. Reject and re-ask on:

- uppercase letters
- underscores, spaces, or other separators
- a leading digit or hyphen
- a trailing hyphen

Examples of valid names: `codebase-discovery`, `api-audit`, `migration-planner`, `my-race`.

If the user's first phrasing is close but invalid (e.g. `CodebaseDiscovery`), offer the kebab-case form back and ask them to confirm.

### Step 2 — Pick a template

Four templates ship with the generator. Match the user's described intent against the templates first; only fall back to `AskUserQuestion` when the intent is ambiguous.

| Template | Shape | When to pick it |
|---|---|---|
| `blank` | one prompt runner | the user wants a near-empty starting point and will fill in the runners themselves |
| `linear` | N prompt runners in series | the user described a straight sequence of runners (A feeds B feeds C) |
| `fan-out` | prep · parallel branches · merge | the user described two or more independent branches that later merge |
| `discovery` | modeled on `codebase-discovery` | the user described reading a codebase or repo and producing a structured report |

If the user's first message already names a topology ("I want a linear four-runner race", "fan it out into two branches", "something like codebase-discovery"), pick the template directly and confirm with one sentence: "Using the `linear` template — four runners in series."

Otherwise, ask:

> Which topology fits your race?
>
>  · blank     · one runner · fill it in yourself
>  · linear    · N runners in series
>  · fan-out   · prep, then parallel branches, then merge
>  · discovery · modeled on codebase-discovery (inventory → entities + services → report)

### Step 3 — Elicit the high-level runners

For `blank` and `discovery`, the runner set is fixed by the template and this step is skipped — just confirm the template's default runner names with the user.

For `linear` and `fan-out`, ask the user to name the runners. Keep it conversational, not a form:

> What are the runners? Give each a short kebab-case name. For `linear`, list them in order. For `fan-out`, give me the prep runner, the parallel branch runners, and the merge runner separately.

Validate each runner name the same way as the race name (kebab-case). Reject reserved names: `input`, `output`, `run`, `state`.

A race must have at least one runner and no more than 20 runners at scaffold time. If the user describes more than 20, ask whether the race should be split into two.

### Step 4 — Choose a model per runner

Default every runner to `sonnet`. Ask once:

> Default every runner to sonnet? (yes / no — answering no lets you pick per runner)

If the user says yes, set every runner to `sonnet` and move on. If the user says no, walk through the runner list and use `AskUserQuestion` per runner:

> Model for runner `<name>`?
>
>  · sonnet (default)
>  · opus
>  · haiku

Do not offer other model names. The three above are the Relay-supported set at scaffold time. The user can edit `race.ts` later to change the model string.

### Step 5 — Write the files

Hand the collected inputs to the scaffold CLI. The CLI copies the selected template directory into `./<race-name>/` and substitutes tokens (`{{pkgName}}`, runner names, model names).

Run it via `Bash`:

```bash
node ~/.claude/skills/relay-generator/dist/cli.js \
  --template <blank|linear|fan-out|discovery> \
  --out ./<race-name> \
  --token pkgName=<race-name> \
  --token "stepNames[0]=<first-runner>" \
  --token "stepNames[1]=<second-runner>" \
  --token "stepNames[2]=<third-runner>"
```

The scaffold CLI is the single source of truth for the token-substitution rules. Do not write the files yourself with `Write` — the CLI enforces the §7.1 layout and catches token typos at scaffold time.

After the CLI reports success, print a short next-step block for the user:

```
 ✓ wrote ./<race-name>/package.json
 ✓ wrote ./<race-name>/race.ts
 ✓ wrote ./<race-name>/prompts/...
 ✓ wrote ./<race-name>/README.md

try it:
    cd <race-name> && relay run .
```

## Output contract (§7.1 directory layout)

Every race package the scaffolder emits has this shape:

```
<race-name>/
├── package.json         # name, version, dep on @relay/core
├── race.ts              # the defineRace() entry point — default export
├── prompts/
│   ├── 01_<runner>.md
│   ├── 02_<runner>.md
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

The generated `package.json` includes the `relay` metadata block (`displayName`, `tags`, `estimatedCostUsd`, `estimatedDurationMin`, `audience`) with placeholder values the user edits later. The generated `README.md` includes the §7.4 ordered sections 1–5 so the race can be published to the catalog without further edits.

For the full contract, see the `race-package-format` skill.

## What this skill does NOT do

Mirrors product spec §6.3.

- Does not build or modify `@relay/core`. It only emits race packages.
- Does not run the race. That is the `relay run` command in `@relay/cli`.
- Does not install dependencies. The user runs `pnpm install` (or `npm install`) inside the new directory after scaffolding.
- Does not have its own runtime. It uses Claude Code's `Read`, `Write`, `AskUserQuestion`, and `Bash` tools — and the bundled scaffold CLI — and nothing else.
- Does not edit existing race packages. Use `Read`/`Write` directly for that.
- Does not publish to npm. That is the `relay publish` command.

## Voice and copy rules

When you print status or error text to the user, follow the Relay voice rules.

- No emojis. Use the symbol vocabulary: `✓` done, `✕` failed, `⚠` warning, `·` separator, `○` pending.
- The word "simply" is banned.
- No trailing `!` on any line.
- Second person, present tense, active voice.
- State what happened; name the next command.

The mark `●─▶●─▶●─▶●` is the Relay signature — use it once, at the top of the final summary, if you print one.
