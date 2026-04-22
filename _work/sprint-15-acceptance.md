# Sprint-15 Acceptance Report

## Vocabulary refactor: Flow → Race, Step → Runner, Handoff → Baton

All waves (0, 1, 2) were committed before this verification pass. This report covers the final sweep, fixes applied, and gate results.

---

## 1. Grep sweep

Two full sweeps were run across `packages/`, `examples/`, `catalog/`, `docs/`, `.claude/`, `CLAUDE.md`, `README.md` for residual old nouns (`handoff`, `handoffs`, `Handoff`, `defineFlow`, `stepId`, `FlowSpec`, `StepSpec`, `HandoffStore`).

### Fixes applied during sweep

| File | Change |
|---|---|
| `packages/core/tests/batons.test.ts` | 6 test descriptions: "handoff id" → "baton id" |
| `packages/core/tests/state.test.ts` | Test description "handoffs + artifacts" → "batons + artifacts"; fixture paths `/runs/r1/handoffs/*.json` → `/runs/r1/batons/*.json` |
| `packages/core/tests/orchestrator/orchestrator.test.ts` | Test description "writes handoffs + state.json between steps" → "writes batons + state.json between runners" |
| `packages/cli/src/banner.ts` | JSDoc example command: `handoffs/entities.json` → `batons/entities.json` |
| `packages/races/codebase-discovery/prompts/04_report.md` | "You have three context handoffs" → "You have three input batons" |
| `packages/races/codebase-discovery/prompts/03_services.md` | "checkpoints, handoffs, atomic writes" → "checkpoints, batons, atomic writes" |
| `packages/races/codebase-discovery/prompts/02_entities.md` | Example JSON summary: "flow's DAG of steps, handling retries, resumption, and handoff validation" → "race's DAG of runners, handling retries, resumption, and baton validation" |

### Known-good residuals (intentionally left)

- `docs/naming-conventions.md` lines 13, 45 — the vocabulary mapping table (`handoff | baton`) is the authoritative record of what was renamed.
- `packages/core/src/errors.ts` — `StepFailureError` is the live class name; not renamed this sprint.
- CSS class names in `catalog/styles.css` (`.flow-card`, etc.) and `catalog/app.js` — internal identifiers, not user-visible copy.
- `_work/sprint-*.json`, `*.code_review.md` — sprint management files, not source.

### Final sweep result

Zero source-file hits on `handoff`, `HandoffStore`, `defineFlow`, `stepId`, `FlowSpec`, `StepSpec` outside of the known-good residuals listed above.

---

## 2. Typecheck — pnpm -r typecheck

All 6 packages passed with zero errors:

- `@relay/core` — Done
- `@relay/generator` — Done
- `@relay/cli` — Done
- `examples/hello-world` — Done
- `examples/hello-world-mocked` — Done
- `packages/races/codebase-discovery` — Done

---

## 3. Test suite — pnpm -F @relay/core test && pnpm -F @relay/cli test

| Package | Test files | Tests | Result |
|---|---|---|---|
| `@relay/core` | 41 passed | 329 passed | PASS |
| `@relay/cli` | 3 passed, 1 skipped | 23 passed, 3 skipped | PASS |

---

## 4. Mocked example smoke test

```
node dist/run-mocked.js
```

Both runners (`greet`, `summarize`) completed. Final output:

```
run-mocked: status=succeeded
run-mocked: runDir=<...>/.relay/runs/a02641
run-mocked: artifacts=<...>/artifacts/greeting.md
run-mocked: durationMs=86
```

Result: PASS

---

## 5. Generator scaffold smoke test

`scaffoldFlow({ template: 'linear', outDir: tmpdir, tokens: { pkgName, stepNames[0..2] } })`

- Scaffold returned `ok({ filesWritten: [README.md, package.json, race.ts, tsconfig.json, prompts/...] })`
- `race.ts` contains `defineRace`
- All 4 templates (`blank`, `linear`, `fan-out`, `discovery`) have `race.ts` with `defineRace`; zero instances of `defineFlow` in any template

Result: PASS

---

## 6. Catalog vocabulary check

User-visible text content (HTML `textContent`, `innerHTML`) in `catalog/index.html` and `catalog/app.js` contains no `flow`, `step`, or `handoff` domain nouns. CSS class names like `.flow-card` are internal identifiers unchanged by product vocabulary.

Result: PASS

---

## 7. Reference race linter

`lintRacePackage('packages/races/codebase-discovery')` returned:

```
0 errors, 0 warnings
```

Result: PASS

---

## Summary

All 7 acceptance gates passed. The sprint-15 naming refactor (Flow → Race, Step → Runner, Handoff → Baton, RunState → RaceState) is complete across packages, examples, catalog, docs, skill references, and agent prompts.
