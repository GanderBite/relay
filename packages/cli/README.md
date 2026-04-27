# @ganderbite/relay

The `relay` command-line binary. Runs flows, manages runs, inspects auth,
and scaffolds new flow packages.

---

## What it does

`@ganderbite/relay` wraps `@ganderbite/relay-core` in a terminal-facing binary. It handles provider
selection, pre-run banners, TTY progress output, and error display. Every command
exits with a documented exit code so CI scripts can distinguish billing
misconfigurations from step failures.

---

## Install

```bash
npm install -g @ganderbite/relay
```

Requires Node ≥ 20.10.

If `relay` is not found after install, ensure the npm global bin directory is in
your PATH. Run `npm bin -g` to locate it, then add that path to your shell
profile (`.zshrc`, `.bashrc`, etc.).

---

## First-time setup

```bash
relay init      # write provider choice to ~/.relay/settings.json
relay doctor    # confirm Node, claude binary, auth state, and .relay dir
```

Without `relay init` the CLI exits with `NoProviderConfiguredError` (exit 6)
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
| 1 | Runner failure — step error or unexpected exception |
| 2 | `FlowDefinitionError` or `ProviderCapabilityError` — malformed flow package |
| 3 | Auth error — `SubscriptionAuthError` or `ProviderAuthError`; see `docs/billing-safety.md` |
| 4 | `HandoffSchemaError` — handoff data did not match the declared schema |
| 5 | Timeout — `TimeoutError` or `AuthTimeoutError` |
| 6 | `NoProviderConfiguredError` — run `relay init` |
| 7 | I/O error — `AtomicWriteError` writing checkpoint or state |
| 8 | Rate limited — `ProviderRateLimitError` |

---

## Billing safety

Relay runs on your Claude subscription. Run `claude /login` once to authenticate.
The CLI exits with code 3 (auth error) if subscription credentials are
not found before any step executes. See `docs/billing-safety.md` for CI guidance.

---

## License

MIT. Copyright Ganderbite.
