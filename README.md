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

Running `relay init` writes your provider choice to `~/.relay/settings.json`. Without
it the runner exits with `NoProviderConfiguredError` before any runner executes.

`relay doctor` tells you if your environment is safe to run. `relay run codebase-discovery .`
produces an HTML report describing this repo — in about 12 minutes,
for about $0.40 (estimated API equivalent; billed to your subscription).

## Why not X?

| I already use... | ...and Relay gives you |
|---|---|
| `claude -p` in a shell script | checkpoint, resume, typed batons, cost tracking, TTY progress |
| LangGraph or CrewAI | a Claude-native runner; no framework to learn; ships with pre-built races |
| SuperClaude / BMAD | a tool, not a persona layer; you define the race |
| `aaddrick/claude-pipeline` | a generator + catalog, not a static template to hand-adapt |
| Claude Code Skills | multi-runner orchestration across skills, with state and resume |

## Docs

- [Race Package Format](docs/race-package-format.md) — directory layout, package.json shape, runner types, versioning
- [Billing Safety](docs/billing-safety.md) — the API-key guard, opt-in paths, env allowlist, `relay doctor`
- [Naming Conventions](docs/naming-conventions.md) — vocabulary table, words to avoid, PR checklist

## Races

The catalog at `packages/races/` contains reference races. Install any race with `relay install <name>`.
Browse available races with `relay list`.

## License

MIT — [full text](LICENSE)

Made by [Ganderbite](https://ganderbite.com). Dogfooded on our own codebase-discovery
and API-audit races. Install with `npm install -g @relay/cli`.
