<p align="center">
  <br>
  <code>●─▶●─▶●─▶●  relay</code>
  <br><br>
  <strong>Claude pipelines you can run twice.</strong>
  <br><br>
</p>

Deterministic orchestration. Crash-proof state. Transparent cost.
Runs on your Pro/Max subscription — no surprise API bills.

## 60-second tour

```bash
npm install -g @relay/cli
relay init                                # choose claude-cli for subscription billing
relay doctor                              # check your environment
relay run codebase-discovery .            # ship a real artifact
```

The `relay init` step writes your provider choice to `~/.relay/settings.json`. Without
it the runner exits with `NoProviderConfiguredError` before any step runs.

`relay doctor` tells you if your environment is safe to run. `relay run codebase-discovery .`
produces an HTML report describing this repo — in about 12 minutes,
for about $0.40 (estimated API equivalent; billed to your subscription).

## Why not X?

| I already use... | ...and Relay gives you |
|---|---|
| `claude -p` in a shell script | checkpoint, resume, typed handoffs, cost tracking, TTY progress |
| LangGraph or CrewAI | a Claude-native runner; no framework to learn; ships with pre-built flows |
| SuperClaude / BMAD | a tool, not a persona layer; you define the pipeline |
| `aaddrick/claude-pipeline` | a generator + catalog, not a static template to hand-adapt |
| Claude Code Skills | multi-step orchestration across skills, with state and resume |

## Docs

- [Flow Package Format](docs/flow-package-format.md) — directory layout, package.json shape, step types, versioning
- [Billing Safety](docs/billing-safety.md) — the API-key guard, opt-in paths, env allowlist, `relay doctor`
- [Naming Conventions](docs/naming-conventions.md) — vocabulary table, words to avoid, PR checklist

## Flows

The catalog at `packages/flows/` contains reference flows. Install any flow with `relay install <name>`.
Browse available flows with `relay list`.

Start from the first-flow guide: [docs/first-flow](docs/first-flow.md)

## License

MIT — [full text](LICENSE)

Made by [Ganderbite](https://ganderbite.com). Dogfooded on our own codebase-discovery
and API-audit flows. Install with `npm install -g @relay/cli`.
