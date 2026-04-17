# Banned Terms

Words and characters that must not appear in user-facing copy. "User-facing" means: CLI output, error messages, banners, README bodies, package.json descriptions, marketing pages. Internal code identifiers, comments, and variable names are exempt.

## Banned words (with replacements)

| Banned | Replace with | Why |
|---|---|---|
| simply | (delete) | If it were simple, we wouldn't have to say so |
| just | (delete) | Filler |
| easy | (show, don't tell — give a one-line example) | Reader decides what's easy |
| powerful | (give the number — `5 steps in 12 min for $0.40`) | Vague |
| awesome / amazing / great | (delete or use exact numbers) | Marketing-speak |
| seamless / effortless | (delete) | The user judges this |
| robust | (delete — let test results say it) | Empty claim |
| modern | (delete) | Time-stamped already |
| next-generation | (delete) | Meaningless |
| AI-powered | (delete) | Now redundant |
| empower / empowering | (use "let") | Buzzword |
| leverage | use | Plain English |
| utilize | use | Plain English |
| best-in-class | (delete or quantify) | Empty claim |
| world-class | (delete) | Empty claim |
| revolutionary | (delete) | Hyperbole |
| game-changing | (delete) | Hyperbole |
| Pro user! | "subscription (pro)" or "subscription (max)" | Patronizing |
| 🚀 / any emoji | the symbol vocabulary or delete | Cuteness ban |

## Banned vocabulary substitutions (product spec §13)

These are technical terms. Use Relay's vocabulary instead.

| Banned | Use | Notes |
|---|---|---|
| pipeline | flow | The product is "Relay flows", not "pipelines" — even though everyone outside this codebase calls them pipelines |
| workflow | flow | Same |
| task | step | "task" is reserved for sprint backlog items |
| stage | step | |
| context | handoff | When referring to data passed between steps |
| message | (avoid in user copy) | Internal SDK term |
| session | run | Always "run" for an execution |
| job | run | |
| save | checkpoint | "state is saved" is acceptable when describing what checkpoints do |
| state | checkpoint | In user copy. In code, `state.json` is fine. |
| template | flow / flow package | Generator emits "templates" internally; user-facing they become "flows" |
| official | verified | The catalog tier is "verified", not "official" |
| recommended | (be specific — "verified by Ganderbite", "popular", etc.) | Editorializing |

## Banned characters

- **Trailing `!`** — replace with `.` or delete the punctuation entirely.
- **Emojis** — any character outside the approved symbol set (`✓ ✕ ⚠ ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ○ · ▶ ⊘ ●─▶`).
- **Smart quotes** in code blocks — use straight `"` and `'`. In prose, either is OK.
- **Tabs** in any output meant to be visually aligned. Always use spaces.

## Banned patterns

- **"As an AI assistant..."** or any meta-reference. Relay is a tool, not a persona.
- **First person plural without an antecedent.** "We've built..." in a README is OK; "We recommend..." in a CLI message reads as a chatbot.
- **Walls of explanation in errors.** A two-line message is too long. Three-line is wrong. Use the §6.6 template: headline, indented explanation, indented `→ <command>` lines.
- **Apologies.** "Sorry, but the operation failed." → "✕ <what failed>. → <next command>".
- **Hedge words in code paths.** "Sometimes this might fail" — pick. Either it fails or it doesn't.

## Sweep checklist for new copy

Before committing any user-facing string:

1. ☐ Grep for `simply` — none allowed.
2. ☐ Grep for `!` at end of line — none allowed.
3. ☐ Grep for emojis — none allowed (except the approved symbols).
4. ☐ Verify any "pipeline"/"workflow"/"task"/"stage" mentions are intentional (rare exceptions: comparison grids that name competitor terms).
5. ☐ Read aloud — does it sound like marketing or like a senior engineer? Senior engineer wins.
