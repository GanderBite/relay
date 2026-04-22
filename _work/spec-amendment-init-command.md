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
