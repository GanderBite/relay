# Script and Branch Steps: Env Containment Boundary

## The boundary

`step.prompt` runs in a contained subprocess. The step runner builds an explicit env
allowlist (`PATH`, `HOME`, `USER`, `LANG`, `TZ`, `TMPDIR`, `SHELL`, `CLAUDE_*`) and
passes only those vars to the `claude` binary. Everything else is suppressed.

`step.script` and `step.branch` forward `process.env` intact to the spawned shell.
Every var on the machine — including `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`,
and any other credential — is visible to the child process.

This is by design. Script and branch steps are user-controlled shell.

## Concrete example

```ts
{ type: 'script', run: 'curl -s -X POST $WEBHOOK_URL -d @handoffs/summary.json' }
```

This subprocess receives every var set in the parent shell. If the endpoint logs
headers or the command captures output, those values leave the machine.

## ⚠ Filter explicitly

`step.env` merges on top of `process.env` — it does not replace it. If your script
touches the network or an external tool, unset sensitive vars in the shell wrapper or
spawn a subprocess that receives only what it needs.

`relay doctor` runs a full environment check before any flow executes.
