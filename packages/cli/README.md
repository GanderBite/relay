# @relay/cli

The `relay` command-line binary. Runs flows, manages runs, inspects auth,
and scaffolds new flow packages.

---

## What it does

`@relay/cli` wraps `@relay/core` in a terminal-facing binary. It handles provider
selection, pre-run banners, TTY progress output, and error display. Every command
exits with a documented exit code so CI scripts can distinguish billing
misconfigurations from step failures.

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

Without `relay init` the CLI exits with `NoProviderConfiguredError` (exit 2)
before any step executes.

---

## Commands

### `relay run <flow> [input]`

Run a flow. `<flow>` is a local directory path or a catalog flow name.

```bash
relay run codebase-discovery --repoPath=. --audience=dev
relay run ./packages/flows/codebase-discovery --repoPath=.
```

### `relay resume <runId>`

Resume a run from its last checkpoint. Skips steps that completed successfully.

```bash
relay resume f9c3a2
```

### `relay list`

List installed flows and catalog flows available for install.

### `relay install <name>`

Install a flow from the catalog.

```bash
relay install codebase-discovery
```

### `relay new <name>`

Scaffold a new flow package using the generator.

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
flow        a named, versioned sequence of steps you can run
step        one node in a flow (prompt, script, branch, parallel)
handoff     the JSON one step produces and a later step consumes
run         one execution of a flow; identified by a run id
checkpoint  the saved state of a run after each step completes
```

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error |
| 2 | `NoProviderConfiguredError` — run `relay init` |
| 3 | `ClaudeAuthError` — API key guard; see `docs/billing-safety.md` |
| 4 | `FlowDefinitionError` — malformed flow package |
| 5 | Step failure |

---

## Billing safety

Relay runs on your Claude subscription. Run `claude /login` once to authenticate.
The CLI exits with code 3 (`ClaudeAuthError`) if subscription credentials are
not found before any step executes. See `docs/billing-safety.md` for CI guidance.

---

## License

MIT. Copyright Ganderbite.
