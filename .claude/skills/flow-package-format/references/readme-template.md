# README Template (§7.4)

A fillable skeleton matching the §7.4 contract. Sections 1–5 are mandatory; 6–8 are recommended. Linter ERROR if 1–5 missing; WARN if 6–8 missing.

```markdown
# <Display Name>

`●─▶●─▶●─▶●  <flow-name>`

## What it does

<One paragraph. State the input, the output artifact, and the audience. No
"powerful", no "easy". Numbers if you can — "Reads a TypeScript repo and
produces a 6-section HTML report in about 12 minutes for under $0.50.">

## Sample output

![sample](./examples/sample-output.png)

(Or:)

> An excerpt: <a paragraph from the rendered artifact>

(Or for HTML reports:)

[Full sample report (HTML)](./examples/sample-output.html)

## Estimated cost and duration

- **Cost:** $<min>–$<max> per run (estimated API equivalent; billed to your
  subscription if you're on Pro/Max).
- **Duration:** ~<min>–<max> minutes on a typical M1/M2 Mac.

## Install

```bash
relay install <flow-name>
```

## Run

```bash
relay run <flow-name> <primary-input> [--<flag>=<value>]
```

The most common invocation:

```bash
relay run <flow-name> .
```

## Configuration

The flow accepts these inputs:

| Field | Type | Default | Notes |
|---|---|---|---|
| `<field1>` | `string` | (required) | <one-line description> |
| `<field2>` | `enum` | `<default>` | <one-line description> |

Models per step (override via `relay run <flow> --model.<step>=<model>`):

| Step | Default model |
|---|---|
| `<step1>` | `sonnet` |
| `<step2>` | `sonnet` |

## Customization

Fork the flow:

```bash
relay install <flow-name>
mv ./.relay/flows/<flow-name> ./<my-fork>
cd ./<my-fork>
# edit prompts/, schemas/, flow.ts, then:
relay run .
```

Common customizations:

- **Swap the model** — change `model: 'sonnet'` to `'opus'` in `flow.ts`.
- **Tighten the schema** — edit `schemas/<name>.ts` to require/optionalize fields.
- **Change the report layout** — edit `templates/report.html.ejs`.

## License

MIT. Copyright Ganderbite.
```

## Voice notes

- No emojis. The mark `●─▶●─▶●─▶●` is the only special-character branding.
- No "simply", no "easy", no "powerful" without numbers.
- Second person, present tense, active voice.
- Number the cost honestly. If you don't have a number, omit the claim.

## Things to verify before commit

- The install command in §4 matches what `relay install` actually accepts.
- The run command in §5 matches the input schema in `flow.ts`.
- The configuration table in §6 reflects every field in the input schema.
- The sample output exists and renders without external assets (HTML reports inline their CSS).
- The license matches `package.json` `license` field.
