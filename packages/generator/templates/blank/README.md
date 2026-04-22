# {{pkgName}}

## What it does

One paragraph describing what this race produces and who it is for. Replace this text with your own description before publishing.

## Sample output

Paste an excerpt of a real run, or link to an image under `examples/`. Catalog homepage requires this section.

## Estimated cost and duration

- Cost: $0.00 – $0.00 per run (subscription billing: zero marginal cost)
- Duration: 1 – 5 minutes

Update these numbers after you run the race a handful of times.

## Install

```
relay install {{pkgName}}
```

## Run

```
relay run {{pkgName}} --subject "your subject here"
```

## Configuration

This race exposes the following inputs:

- `subject` (string, required) — the topic the first runner writes about.

## Customization

Fork this package, edit `prompts/01_first.md` and `race.ts`, then run `relay run .` from the race directory to test locally.

## License

MIT
