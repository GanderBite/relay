# @relay/generator

The Claude Code skill and scaffold engine that generates new flow packages.

---

## What it does

`@relay/generator` creates a well-formed flow package directory from a layout name
and a flow name. It produces `flow.ts`, a `prompts/` directory, a `package.json`
with the `relay` metadata block, a `tsconfig.json`, and a `README.md` that matches
the mandatory sections in `docs/flow-package-format.md`.

The generator runs as a Claude Code skill (invocable from within the CLI via
`relay new`) or as a standalone binary (`relay-generator`).

---

## Install

`@relay/generator` is included when you install `@relay/cli`:

```bash
npm install -g @relay/cli
```

---

## Usage via CLI

```bash
relay new <flow-name>
relay new <flow-name> --layout=linear
relay new <flow-name> --layout=fan-out
relay new <flow-name> --layout=discovery
```

Available layouts: `blank`, `linear`, `fan-out`, `discovery`.

The `blank` layout produces a single-step flow with one prompt file.
`linear` produces three steps in sequence. `fan-out` produces one upstream
step and two parallel downstream steps. `discovery` mirrors the
`codebase-discovery` shape: one upstream, two parallel, one synthesis.

---

## Usage as a standalone binary

```bash
relay-generator --name=my-audit --layout=linear --out=./packages/flows/my-audit
```

Flags:

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--name` | yes | — | The flow name, used as the `name` field in `defineFlow` and `package.json`. |
| `--layout` | yes | — | One of `blank`, `linear`, `fan-out`, `discovery`. |
| `--out` | no | `./<name>` | Output directory. Created if it does not exist. |

---

## Generated package shape

The generator writes a directory that passes catalog lint:

```
<flow-name>/
├── package.json      # @ganderbite/flow-<name>, relay metadata block
├── flow.ts           # defineFlow() default export
├── prompts/          # one .md file per step
├── schemas/          # placeholder for Zod schema files
├── README.md         # mandatory sections pre-filled
└── tsconfig.json     # extends @relay/core/tsconfig
```

See `docs/flow-package-format.md` for the full format reference.

---

## License

MIT. Copyright Ganderbite.
