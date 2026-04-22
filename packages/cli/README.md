# @relay/cli

The `relay` command-line binary. Runs races, manages runs, inspects auth,
and scaffolds new race packages.

---

## What it does

`@relay/cli` wraps `@relay/core` in a terminal-facing binary. It handles provider
selection, pre-run banners, TTY progress output, and error display. Every command
exits with a documented exit code so CI scripts can distinguish billing
misconfigurations from runner failures.

---

## Install

```bash
npm install -g @relay/cli
```

Requires Node ≥ 20.10.

---

## First-time setup

```bash
relay init      # write provider choice to ~/.relay/settings.json
relay doctor    # confirm Node, claude binary, auth state, and .relay dir
```

Without `relay init` the runner exits with `NoProviderConfiguredError` (exit 2)
before any runner executes.

---

## Commands

### `relay run <race> [input]`

Run a race. `<race>` is a local directory path or a catalog race name.

```bash
relay run codebase-discovery --repoPath=. --audience=dev
relay run ./packages/races/codebase-discovery --repoPath=.
```

Pass `--api-key` to opt in to `ANTHROPIC_API_KEY` billing explicitly.

### `relay resume <runId>`

Resume a run from its last checkpoint. Skips runners that completed successfully.

```bash
relay resume f9c3a2
```

### `relay list`

List installed races and catalog races available for install.

### `relay install <name>`

Install a race from the catalog.

```bash
relay install codebase-discovery
```

### `relay new <name>`

Scaffold a new race package using the generator.

```bash
relay new my-audit
```

### `relay doctor`

Check Node version, `claude` binary, auth state, and `.relay` directory.
Exits 0 if no blockers, 3 if only the API-key guard is blocking, 1 for other
blockers.

### `relay --help glossary`

Print the vocabulary table:

```
race        a named, versioned pipeline you can run
runner      one node in a race (prompt, script, branch, parallel)
baton       the JSON one runner produces and a later runner consumes
run         one execution of a race; identified by a run id
checkpoint  the saved state of a run after each runner completes
```

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error |
| 2 | `NoProviderConfiguredError` — run `relay init` |
| 3 | `ClaudeAuthError` — API key guard; see `docs/billing-safety.md` |
| 4 | `RaceDefinitionError` — malformed race package |
| 5 | Runner failure |

---

## Billing safety

Relay defaults to subscription billing. If `ANTHROPIC_API_KEY` is set in your
environment, the CLI exits with code 3 before any runner executes. Pass `--api-key`
or set `RELAY_ALLOW_API_KEY=1` to opt in explicitly. See `docs/billing-safety.md`
for the full auth precedence table and CI guidance.

---

## License

MIT. Copyright Ganderbite.
