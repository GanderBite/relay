# Relay Naming Conventions

> Living document. When you add user-facing copy — a CLI output string, error message, README paragraph, or catalog description — check every word against the **Words to avoid** column before merging. A match is a bug.

---

## Vocabulary table

| Term | Definition | Words to avoid |
|---|---|---|
| **flow** | A named, versioned sequence of steps you can run | "pipeline" (too generic), "workflow" (too loaded), "race" |
| **step** | One node in a flow — prompt, script, branch, or parallel | "task" (conflicts with system task primitives), "stage", "runner" |
| **handoff** | The JSON one step produces and a later step consumes | "context", "message", "baton" |
| **run** | One execution of a flow, identified by a run id | "session" (conflicts with Claude session concept), "job" |
| **checkpoint** | The saved state of a run after each step completes | "save", "state" (the file on disk is `state.json`, but the UX word is *checkpoint*) |
| **catalog flow** | A flow fetched from the public catalog and installed locally | "template" (implies you customize a blank; catalog flows are complete, runnable artifacts) |
| **verified** | The Ganderbite-reviewed tier in the catalog | "official", "recommended" |

### One-line glossary

The block below is reproduced verbatim in `relay --help glossary`. Do not paraphrase.

```
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

---

## Full words-to-avoid list

Any of these appearing in a user-facing string — CLI output, error message, README body, catalog description, or marketing copy — is a bug.

| Avoid | Use instead |
|---|---|
| pipeline | flow |
| workflow | flow |
| race | flow |
| task | step |
| stage | step |
| runner | step |
| baton | handoff |
| context | handoff |
| message | handoff |
| session | run |
| job | run |
| save | checkpoint |
| state | checkpoint (in copy directed at users; `state.json` is acceptable in technical docs and code) |
| template | flow, flow package, or catalog flow depending on context |
| official | verified |
| recommended | verified |

---

## Enforcement

Any user-facing copy that introduces a word from the **Words to avoid** column is a bug with the same weight as a failing test. "User-facing" means:

- Text written to stdout or stderr by any `relay` command.
- Error message strings surfaced to the terminal.
- README bodies in `packages/*/README.md` and flow package READMEs.
- Copy kit strings in `docs/copy-kit.md`.
- Catalog descriptions, page headers, and badge labels.

It does **not** cover: TypeScript/JavaScript identifiers (variable names, function names, property keys, flag names), internal code comments, or spec files.

---

## Known drift

The following user-facing strings in the current codebase contain words from the avoid list. Each entry shows file and line number. These are bugs to fix — none require a behavioral change, only copy edits.

### "template" in user-facing output

**`packages/cli/src/dispatcher.ts:154`**
```
.option('--template <name>', 'template to use (blank|linear|fan-out|discovery)', undefined)
```
The help description `template to use` is user-facing (`relay new --help`). Preferred: `flow layout to use (blank|linear|fan-out|discovery)`.

**`packages/cli/src/commands/new.ts:42`**
```
'or, to skip the skill and start from a blank template:\n'
```
User-facing Mode A output. Preferred: `or, to skip the skill and start from a blank flow:`.

**`packages/cli/src/commands/new.ts:61`**
```
lines.push(`${MARK}  relay new ${name} (${template} template)`);
```
Header line printed to stdout. Preferred: `relay new ${name}  ·  ${template} layout`.

**`packages/cli/src/commands/new.ts:108`**
```
`${red(`${SYMBOLS.fail} unknown template: "${templateRaw}"`)}\n`
```
Error message to stderr. Preferred: `unknown layout: "${templateRaw}"`.

**`packages/cli/src/commands/new.ts:110`**
```
'  valid templates: blank, linear, fan-out, discovery.\n'
```
Error body to stderr. Preferred: `valid layouts: blank, linear, fan-out, discovery.`.

**`packages/cli/src/commands/new.ts:140`**
```
`${red(`${SYMBOLS.fail} template not found: "${e.template}"`)}\n`
```
Error message to stderr. Preferred: `layout not found: "${e.template}"`.

**`packages/generator/src/cli.ts:27`**
```
process.stderr.write(`scaffold: unknown template: ${val} (choose: blank, linear, fan-out, discovery)\n`);
```
Generator CLI stderr. Preferred: `scaffold: unknown layout: ${val} (choose: blank, linear, fan-out, discovery)`.

**`packages/generator/src/cli.ts:65`**
```
process.stderr.write('scaffold: --template is required (blank | linear | fan-out | discovery)\n');
```
Generator CLI stderr. Preferred: `scaffold: --layout is required (blank | linear | fan-out | discovery)`.

**`packages/generator/src/cli.ts:79`**
```
process.stderr.write(`scaffold: template not found: ${e.template}\n`);
```
Generator CLI stderr. Preferred: `scaffold: layout not found: ${e.template}`.

### "recommended" in user-facing output

**`packages/cli/src/exit-codes.ts`**
```
remediation('run: claude /login')
```
Auth error remediations use imperative form: state the exact command to run. Do not add `(recommended)` qualifiers — there is only one path.

---

## PR checklist — new CLI copy

When a pull request adds or changes any user-facing string, verify each item before merging:

- [ ] No word from the **Words to avoid** list appears in any string written to stdout, stderr, or a README body.
- [ ] Every error message names the next command (no dead-ends).
- [ ] No trailing `!` on any output line.
- [ ] No `simply`, `easy`, `just`, or `powerful` (without a number attached).
- [ ] No emojis — symbol vocabulary only: `✓ ✕ ⚠ ○ · ▶ ⊘ ⠋` and the mark `●─▶●─▶●─▶●`.
- [ ] Dollar amounts are exact (e.g. `$0.005`, `$0.40`), never rounded for appearance.
- [ ] Second person, present tense, active voice throughout.
- [ ] Command examples in copy match what the binary actually accepts (cross-check `relay --help`).
