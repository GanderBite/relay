# Troubleshooting

Common errors, their causes, and remediation steps.

---

## Table of contents

- [`StepFailureError`](#stepfailureerror)
- [`HandoffSchemaError`](#handoffschemaerror)
- [`ProviderCapabilityError`](#providercapabilityerror)
- [`NoProviderConfiguredError`](#noproviderconfigurederror)
- [`ClaudeAuthError` (subscription billing guard)](#claudeautherror)
- [`StateCorruptError`](#statecorrupterror)
- [`StateVersionMismatchError`](#stateversionmismatcherror)
- [`HandoffNotFoundError`](#handoffnotfounderror)
- [`relay doctor` blocking failures](#relay-doctor-blocking-failures)

---

### `StepFailureError`

**What it means.** A step exited non-zero or threw an unhandled error after all retry attempts were exhausted.

**Most common cause.** The prompt returned output the step's script or downstream schema did not expect, or an external command the step invoked returned a non-zero exit code.

→ Inspect the partial artifact in `.relay/runs/<runId>/` and read the step's captured stderr in the error output.
→ Adjust the prompt file for the failing step, then resume from the last checkpoint:
```
relay resume <runId>
```
→ View the full structured log for the run to identify where the step diverged:
```
relay logs <runId> --step <stepId>
```

---

### `HandoffSchemaError`

**What it means.** The JSON a step wrote to its output handoff did not match the schema the consuming step declared.

**Most common cause.** The producing step's prompt returned a structure that differs from the Zod schema declared in `output.schema` inside `flow.ts`.

To inspect the exact validation failures, read the `issues` array on the error object. The CLI prints each issue in the format `path: message`. For example:

```
HandoffSchemaError: handoff "entities" failed schema validation
  [0] path: summary · expected string, received number
  [1] path: items[2].name · required
```

→ Compare the printed issues against the schema in `flow.ts` and adjust either the schema or the prompt so the producing step's output matches.
→ If the mismatch is in a prompt you control, edit the prompt file to constrain the output format, then resume:
```
relay resume <runId>
```
→ If the schema itself needs widening, update `output.schema` in `flow.ts`, rebuild the flow package (`pnpm build`), and start a fresh run.

---

### `ProviderCapabilityError`

**What it means.** A step in the flow requests a feature the configured provider does not advertise. This is checked at flow-load time — no tokens are spent before this error surfaces.

**Most common cause.** The flow's `flow.ts` asks for a capability (`output.schema`, a specific model, a tool, or `maxBudgetUsd`) that the current provider does not support.

The capabilities currently advertised by each built-in provider:

| Provider | `structuredOutput` | `tools` | `models` | `budgetCap` |
|---|---|---|---|---|
| `claude-cli` | `true` | `true` | `sonnet`, `haiku`, `opus` | `true` |

→ Run `relay doctor` to confirm which provider is configured and what its capabilities are.
→ If the flow requires a capability your provider lacks, switch to a provider that supports it:
```
relay config set provider claude-cli
```
→ If the capability is optional in your flow, remove the unsupported option from the step definition in `flow.ts`.

---

### `NoProviderConfiguredError`

**What it means.** Relay could not find a provider in any of the three configuration layers: the `--provider` flag, the flow's local `settings.json`, or the global `~/.relay/settings.json`.

**Most common cause.** `relay init` has not been run yet, or the global settings file was deleted.

→ Run the interactive setup to write a provider to the global settings:
```
relay init
```
→ Or write the provider directly:
```
relay config set provider claude-cli
```
→ Or pass the provider for a single run without changing settings:
```
relay run <flowName> <input> --provider claude-cli
```

---

### `ClaudeAuthError`

**What it means.** The environment is unsafe to spawn Claude. Relay detected `ANTHROPIC_API_KEY` in the environment without an explicit opt-in, or the subscription token is absent.

**Most common cause.** `ANTHROPIC_API_KEY` is set in the shell environment. Relay defaults to subscription billing. If the key is present without an opt-in, any run would silently bill the API account — Relay blocks the run before any subprocess is launched to prevent this.

This is the billing safety guard. Full details are in [`docs/billing-safety.md`](billing-safety.md).

→ Unset `ANTHROPIC_API_KEY` to use subscription billing (the default and recommended path):
```
unset ANTHROPIC_API_KEY
relay run <flowName> <input>
```
→ To explicitly opt in to API-account billing for a single run, pass the flag:
```
relay run <flowName> <input> --api-key
```
→ To opt in via environment variable (useful in CI):
```
RELAY_ALLOW_API_KEY=1 relay run <flowName> <input>
```

---

### `StateCorruptError`

**What it means.** The `state.json` file for a run exists on disk but cannot be parsed or does not match the expected shape.

**Most common cause.** The file was manually edited, partially written during a hard crash (e.g. power loss during a write), or produced by an incompatible version of Relay.

⚠ Runs in this state are **not resumable**. The checkpoint data cannot be trusted, so `relay resume` will not work.

→ Identify the corrupt run directory:
```
relay runs
```
→ Remove the run directory and start fresh:
```
rm -rf .relay/runs/<runId>
relay run <flowName> <input>
```

---

### `StateVersionMismatchError`

**What it means.** The persisted checkpoint was written by a different flow name or version than the one currently loaded. Safe resumption is impossible because the step graph may have changed.

**Most common cause.** The flow package was upgraded (or renamed) between the original run and the resume attempt.

⚠ Runs in this state are **not resumable** with the current flow version.

→ To resume with the original flow version, check out the version that produced the run and retry:
```
relay resume <runId>
```
→ If the original version is unavailable or you prefer to start fresh:
```
relay run <flowName> <input>
```
→ To see the expected and actual flow name/version that triggered the mismatch, check the error output — both `expected` and `actual` fields are printed.

---

### `HandoffNotFoundError`

**What it means.** A step attempted to read a handoff that was never written to disk.

**Most common cause.** A step's `dependsOn` declaration in `flow.ts` is missing or incorrect — the consuming step ran before the producing step completed, or the producing step's output handoff id does not match the consuming step's input handoff id.

→ Open `flow.ts` and verify that the consuming step's `dependsOn` array lists the producing step's id:

```ts
steps: {
  inventory: step.prompt({
    promptFile: 'inventory.md',
    output: { handoff: 'inventory-out' },
  }),
  report: step.prompt({
    promptFile: 'report.md',
    dependsOn: ['inventory'],          // ← must name the producing step
    output: { handoff: 'report-out' },
  }),
}
```

→ Confirm the handoff id written by the producer (`output.handoff`) matches the id the consumer reads. The error message includes the missing handoff id.
→ After correcting `flow.ts`, rebuild and start a fresh run:
```
pnpm build
relay run <flowName> <input>
```

---

### `relay doctor` blocking failures

`relay doctor` runs pre-flight checks and exits with code `1` if any blocker is present. The three categories of blocking failures:

#### Node version below 20.10.0

```
✕ node          18.x.x  (≥ 20.10.0 required)
```

**Cause.** The active Node.js version is below the minimum required.

→ Install Node.js 20.10.0 or later from [nodejs.org](https://nodejs.org), or use a version manager:
```
nvm install 20
nvm use 20
```

#### `claude` binary not on PATH

```
✕ claude        not found — install from https://claude.com/code/install
```

**Cause.** The `claude` binary is not installed or not on the current `PATH`.

→ Install the Claude Code CLI:
```
npm install -g @anthropic-ai/claude-code
```
→ Verify the binary is reachable:
```
claude --version
```

#### `.relay` directory not writable

```
✕ dir           ./.relay not writable
```

**Cause.** The `.relay` directory in the current working directory exists but cannot be written to, or the directory cannot be created.

→ Check and correct directory permissions:
```
chmod u+w .relay
```
→ If the directory does not exist and cannot be created, verify the working directory is writable:
```
ls -la .
```

#### No provider configured (resolver block)

The resolver block at the bottom of `relay doctor` output also blocks when no provider is configured:

```
  no provider configured. run `relay init` to pick one, or pass `--provider claude-cli`.
```

→ See [`NoProviderConfiguredError`](#noproviderconfigurederror) above.
