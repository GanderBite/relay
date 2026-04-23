---
name: relay-brand-grammar
description: The Relay brand grammar — the mark, symbol vocabulary, color rules, voice principles, banned words, naming conventions, and verbatim copy blocks. Trigger this skill whenever you write any user-visible string — CLI command output, banner, error message, README, marketing copy, catalog page, or generator template README. This is the single source of truth for what Relay sounds like; the product spec lives in `_specs/relay-product_spec.md` and this skill distills the rules an agent needs at write time. As of sprint 19, the canonical nouns are Flow / Step / Handoff — the old nouns Race / Runner / Baton are forbidden in user-facing copy.
---

# Relay Brand Grammar

Every byte Relay emits goes through these rules. The product spec at `_specs/relay-product_spec.md` is the canonical source — this skill quotes the parts you reach for most.

## The mark

```
●─▶●─▶●─▶●
```

Four nodes, three arrows. Reads as "steps connected by handoffs." Use sites:

- Every CLI banner starts with it.
- `relay --version` prints it next to the version.
- READMEs use it as the centered hero element.
- The catalog uses it as a favicon-scale mark.

The wordmark is `●─▶●─▶●─▶●  relay` (always two spaces between mark and word, lowercase `relay`).

## Symbol vocabulary

| Symbol | Meaning |
|---|---|
| `✓` | Step or check succeeded |
| `✕` | Step or check failed |
| `⚠` | Warning, user should read |
| `⠋` (and `⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`) | Spinner — step is running |
| `○` | Pending |
| `·` | Separator |
| `▶` | Arrow / flow direction |
| `⊘` | Cancelled / paused mid-step |

These are Unicode, not emoji. **No emoji anywhere in output.** Ever.

## Voice principles (product spec §4.1)

Power users hate cuteness in terminal tools. They also hate condescension. Relay's voice is **calm, specific, and honest**. It sounds like a senior engineer giving you a status update, not a product trying to entertain you.

| Do | Don't |
|---|---|
| State what happened | Celebrate what happened |
| Give exact numbers | Round for vibes |
| Name the next action | Hope the user figures it out |
| Label costs honestly | Bury cost disclosures |
| Say "subscription (max)" | Say "Pro user! 🚀" |
| Second person, present tense, active voice | Marketing speak |

## Banned tokens

These never appear in user-facing copy:

- The word **"simply"** ("if it were simple, we'd have automated it")
- Trailing **`!`** on any line
- **Emojis** (use the symbol vocabulary instead)
- **"Pro user!"**, **"awesome"**, **"powerful"** without numbers attached
- **Words to avoid** from product spec §13: `pipeline` (use *flow*), `workflow` (use *flow*), `task` (use *step*), `stage` (use *step*), `context` (use *handoff*), `message`, `session`, `job`, `save` (use *checkpoint*), `state` (use *checkpoint* in copy, *state* is acceptable in code), `template` (use *flow* or *flow package*), `official`, `recommended`
- **Forbidden old nouns in user-facing copy:** `race`, `runner`, `baton` — use `flow`, `step`, `handoff` respectively. These old nouns are acceptable in code identifiers and internal type names for backward compatibility, but must not appear in CLI output, READMEs, catalog pages, error messages, or any other user-facing string.

## Canonical vocabulary table (sprint 19+)

| Old noun (forbidden in copy) | New noun | Code type / export |
|---|---|---|
| `race` / `Race` | `flow` / `Flow` | `Flow`, `defineFlow` |
| `runner` / `Runner` | `step` / `Step` | `Step`, `step.prompt` |
| `baton` / `Baton` | `handoff` / `Handoff` | `Handoff` |
| `race.ts` | `flow.ts` | entry point filename |
| `defineRace` | `defineFlow` | exported function |
| `raceName` | `flowName` | field name |
| `packages/races/` | `packages/flows/` | directory path |
| `race-package-format` skill | `flow-package-format` skill | skill name |

## Naming the primitives (product spec §13 — updated glossary)

```
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

When you write a doc that lists these — paste the block above unchanged.

## Color rules (TTY only)

- **Green** for completed steps, successful auth, money-in-subscription.
- **Yellow** for in-flight work, warnings, API-billing mode.
- **Red** for failed steps, broken auth, refused runs.
- **Gray** (dim) for pending steps, metadata, secondary text.
- **No color** when stdout is not a TTY, or when `NO_COLOR` is set, or when `--no-color` is passed, or when `~/.relay/config.json` says `color: "never"`.

## Layout idioms

### Banner shape
```
●─▶●─▶●─▶●  <verb-or-flow-name>  [<runId>]  [<status-symbol>]

<aligned kv rows>
[blank]
<step grid>
[blank]
<summary line>
[blank]
next:
    <action>        <command>
```

### KV rows (column-aligned)
```
flow     codebase-discovery v0.1.0
input    .  (audience=both)
run      f9c3a2  ·  2026-04-17 14:32
bill     subscription (max)  ·  no api charges
est      $0.40  ·  5 steps  ·  ~12 min
```

### Step rows (column-aligned, status column wins the eye)
```
 ✓ inventory       sonnet     2.1s    1.4K→0.3K    $0.005
 ⠋ entities        sonnet     turn 3  0.8K→0.4K    ~$0.019
 ○ designReview    waiting on entities, services
```

## Hard-stop rules for new copy

1. **Never silently bill the API.** Every banner names the billing source. The `bill` row in the pre-run banner is mandatory.
2. **Every error names the next command.** No dead-ends.
3. **"State is saved after every step"** — say this in the pre-run banner footer. It's the trust contract.
4. **Verbatim copy blocks** — when the product spec example shows exact text, paste it; don't rewrite.

## References

- `references/voice-rules.md` — long-form voice guide with examples.
- `references/visual-grammar.md` — symbol set, color palette, layout templates.
- `references/banned-terms.md` — the do-not-use list with replacements.
- `references/example-outputs.md` — verbatim banners and error templates from product spec §6.
