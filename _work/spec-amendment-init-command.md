# Spec Amendment: USAGE block in §6.1 (relay init row)

**Status:** proposed — pending user sign-off

## Proposed change

Add `relay init` as the first row of the USAGE block in §6.1.

### Original §6.1 USAGE block:

```
USAGE
    relay <flow> [input]           run a flow (shorthand)
    relay run <flow> [input]       same, explicit form
    relay resume <runId>            continue a failed or stopped run
    relay doctor                    check your environment before running
```

### Proposed §6.1 USAGE block:

```
USAGE
    relay init                      pick your provider and write settings
    relay <flow> [input]           run a flow (shorthand)
    relay run <flow> [input]       same, explicit form
    relay resume <runId>            continue a failed or stopped run
    relay doctor                    check your environment before running
```

## Rationale

Sprint-13 (task_124) added `relay init` as a required first step. The
three-tier provider resolver hard-errors with `NoProviderConfiguredError`
when no provider is configured. Omitting `relay init` from the help would
describe a broken first-run experience.

## Implementation note

The `relay init` row uses the 32-char verb column (description starting at
column 36), consistent with the majority of rows in §6.1. The original two
USAGE rows (`relay <flow> [input]` and `relay run <flow> [input]`) use a
31-char verb column (description at column 35) as written in the original
spec; these are preserved unchanged.

---

# Spec Amendment: §7.2 README hero (relay init in 60-second tour)

**Status:** proposed — pending user sign-off

## Proposed change

Add `relay init` as the second command in the §7.2 60-second tour bash block,
between `npm install -g @relay/cli` and `relay doctor`.

### Original §7.2 bash block:

```bash
npm install -g @relay/cli
relay doctor                              # check your environment
relay run codebase-discovery .            # ship a real artifact
```

### Proposed §7.2 bash block:

```bash
npm install -g @relay/cli
relay init                                # choose claude-cli for subscription billing
relay doctor                              # check your environment
relay run codebase-discovery .            # ship a real artifact
```

## Rationale

Sprint-13 (task_124) added `relay init` as a required first step. The
three-tier provider resolver hard-errors with `NoProviderConfiguredError`
when no provider is configured. Running `relay doctor` or `relay run` on a
fresh install without first running `relay init` will always fail. The
original §7.2 three-command tour describes a broken first-run experience;
the four-command version describes the correct one.

## Implementation note

`README.md` (task_86) has been written with the four-command version.
The prose following the bash block explains the `relay init` requirement.
This amendment is filed per the task specification — merge is blocked
pending user sign-off if byte-exact §7.2 compliance is required.
