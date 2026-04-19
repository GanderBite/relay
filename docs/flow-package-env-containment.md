# Script and Branch Steps: Env Containment Boundary

## The boundary

`step.prompt` runs in a contained subprocess. The runner builds an explicit env
allowlist (`PATH`, `HOME`, `USER`, `LANG`, `TZ`, `TMPDIR`, `SHELL`, `CLAUDE_*`, opt-in
`ANTHROPIC_*`) and passes only those vars to the SDK. `ANTHROPIC_API_KEY` is suppressed
unless the caller opted in (§8.1).

`step.script` and `step.branch` forward `process.env` intact to the spawned shell.
Every var on the machine — including `ANTHROPIC_API_KEY` — is visible to the child
process.

This is by design (§4.4.2, §4.4.3). Script and branch steps are user-controlled shell.

## Concrete example

```ts
{ type: 'script', run: 'curl -s -X POST $WEBHOOK_URL -d @handoffs/summary.json' }
```

This subprocess receives `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`,
and every other var set in the runner's shell. If the endpoint logs headers or the
command captures output, those values leave the machine.

## ⚠ Filter explicitly

`step.env` merges on top of `process.env` — it does not replace it. If your script
touches the network or an external tool, unset sensitive vars in the shell wrapper or
spawn a subprocess that receives only what it needs.

`relay doctor` surfaces whether `ANTHROPIC_API_KEY` is present before any flow runs.
