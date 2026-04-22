# @relay/generator

The Claude Code skill and scaffold engine that generates new race packages.

---

## What it does

`@relay/generator` creates a well-formed race package directory from a layout name
and a race name. It produces `race.ts`, a `prompts/` directory, a `package.json`
with the `relay` metadata block, a `tsconfig.json`, and a `README.md` that matches
the mandatory sections in `docs/race-package-format.md`.

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
relay new <race-name>
relay new <race-name> --layout=linear
relay new <race-name> --layout=fan-out
relay new <race-name> --layout=discovery
```

Available layouts: `blank`, `linear`, `fan-out`, `discovery`.

The `blank` layout produces a single-runner race with one prompt file.
`linear` produces three runners in sequence. `fan-out` produces one upstream
runner and two parallel downstream runners. `discovery` mirrors the
`codebase-discovery` shape: one upstream, two parallel, one synthesis.

---

## Usage as a standalone binary

```bash
relay-generator --name=my-audit --layout=linear --out=./packages/races/my-audit
```

Flags:

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--name` | yes | — | The race name, used as the `name` field in `defineRace` and `package.json`. |
| `--layout` | yes | — | One of `blank`, `linear`, `fan-out`, `discovery`. |
| `--out` | no | `./<name>` | Output directory. Created if it does not exist. |

---

## Generated package shape

The generator writes a directory that passes catalog lint:

```
<race-name>/
├── package.json      # @ganderbite/race-<name>, relay metadata block
├── race.ts           # defineRace() default export
├── prompts/          # one .md file per runner
├── schemas/          # placeholder for Zod schema files
├── README.md         # mandatory sections pre-filled
└── tsconfig.json     # extends @relay/core/tsconfig
```

See `docs/race-package-format.md` for the full format reference.

---

## License

MIT. Copyright Ganderbite.
