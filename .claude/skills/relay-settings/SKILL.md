---
name: relay-settings
description: The three-tier provider selection model — `--provider` flag, race-level settings.json, global settings.json, and `NoProviderConfiguredError`. The settings schema (currently `{ provider? }`), the `relay init` command contract, path helpers `globalSettingsPath` and `raceSettingsPath`, and the `resolveProvider` function. Trigger this skill when implementing or changing provider resolution, `relay init`, settings loading, or any code that reads or writes `~/.relay/settings.json` or `<raceDir>/settings.json`.
---

# relay-settings

The settings module handles how Relay selects a provider for each run. The core contract: a provider must be named before any tokens are spent, and the user must be told exactly how to name one when none is configured.

## When to trigger

- Implementing or changing `packages/core/src/settings/`.
- Wiring `relay init` in `packages/cli/`.
- Adding new fields to the settings schema.
- Writing tests that cover `resolveProvider`, `loadGlobalSettings`, or `loadRaceSettings`.

## Three-tier provider selection

Provider selection uses three sources in priority order. The first non-null value wins:

```
1. --provider <flag>              (CLI flag, per-invocation)
2. <raceDir>/settings.json        (race-level, checked in with the race)
3. ~/.relay/settings.json         (global, user's machine default)
```

If all three are absent or carry no `provider` field, `resolveProvider` returns `err(new NoProviderConfiguredError())`.

The resolver lives at `packages/core/src/settings/resolve.ts` as `resolveProvider(args: ResolveProviderArgs)`. It accepts:

```ts
interface ResolveProviderArgs {
  flagProvider?: string;          // --provider flag value, if passed
  raceSettings: RelaySettings | null;   // loaded from <raceDir>/settings.json
  globalSettings: RelaySettings | null; // loaded from ~/.relay/settings.json
  registry: ProviderRegistry;     // maps provider names to Provider instances
}
```

It returns `Result<Provider, NoProviderConfiguredError | RaceDefinitionError>`. The `RaceDefinitionError` branch fires when a name is found but the registry has no provider registered under that name.

## Settings file schema

```ts
const RelaySettings = z.object({ provider: z.string().min(1).optional() }).passthrough();
type RelaySettings = z.infer<typeof RelaySettings>;
```

`.passthrough()` means unknown keys are preserved rather than stripped — the schema is forward-compatible. Future fields can be added without a breaking change to existing files.

Current fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `provider` | `string` (min 1) | No | Provider name to use (`claude-cli`, `claude-agent-sdk`, or any registered name) |

The schema is validated by `loadSettings` using `RelaySettings.safeParse`. A file that exists but contains invalid JSON, or a file whose content fails schema validation, returns `err(PipelineError)` — it is not silently ignored.


## Paths

```ts
// packages/core/src/settings/paths.ts

globalSettingsPath(): string
  // Returns: path.join(os.homedir(), '.relay', 'settings.json')
  // Example: /Users/alice/.relay/settings.json

raceSettingsPath(raceDir: string): string
  // Returns: path.join(raceDir, 'settings.json')
  // Example: /Users/alice/projects/my-race/settings.json
```

Neither function creates the directory or file — that is `relay init`'s responsibility for the global path, and the race author's responsibility for the race path.

## Loading

```ts
// packages/core/src/settings/load.ts

loadGlobalSettings(): Promise<Result<RelaySettings | null, PipelineError>>
loadRaceSettings(raceDir: string): Promise<Result<RelaySettings | null, PipelineError>>
```

Both return `ok(null)` when the file is absent (ENOENT). Any other read or parse failure returns `err(PipelineError)`. The CLI surfaces these errors before attempting provider resolution.

## relay init

`relay init` is the interactive setup command that writes `~/.relay/settings.json`. The contract:

- **Without flags:** presents a prompt asking the user to choose a provider (`claude-cli` or `claude-agent-sdk`). Writes the chosen name as `{ "provider": "<name>" }`.
- **`--provider <name>`:** skips the prompt. Writes the given name directly.
- **`--force`:** skips the overwrite prompt when `~/.relay/settings.json` already exists. Without `--force`, the command confirms before overwriting.
- Creates `~/.relay/` if it does not exist.
- Writes via an atomic write (temp file + rename) to avoid partial writes.
- On success, prints the path written and the next command to run.

After `relay init` with `claude-cli`, the user still needs to run `claude /login` if they have not done so. `relay doctor` checks for both conditions.

## NoProviderConfiguredError

```
code:    E_NO_PROVIDER
message: no provider configured. run `relay init` to pick one,
         or pass `--provider claude-cli` or `--provider claude-agent-sdk`.
exit:    2 (same as RaceDefinitionError — run cannot proceed before any tokens are spent)
```

The error message is the remediation. No separate "next steps" block is needed — the message names both recovery paths.

`NoProviderConfiguredError` extends `PipelineError` directly, not `RaceDefinitionError`. Its exit code 2 matches by convention, not inheritance.

## Adding new settings fields

1. Add the field to the Zod schema in `packages/core/src/settings/schema.ts` as optional. Use `z.string()`, `z.number()`, or a union — avoid nested objects for now.
2. Update this skill with the new field's meaning.
3. If the field affects provider selection, update `resolveProvider` and this skill's three-tier table.
4. Do not add a `version` field — `.passthrough()` handles forward compatibility without one.
