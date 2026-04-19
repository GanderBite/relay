# Spec Amendment: FLAG-11 — RunResult.status adds 'aborted'

## Explanation

`RunResult.status` in §4.9 currently declares the union `'succeeded' | 'failed'`.
The implementation already emits a third value — `'aborted'` — whenever a run is
interrupted by a signal or ctrl-c before completion (see `runner.ts` lines 258,
453, 986). Aborted is a distinct outcome from failed: no step raised an error;
the user chose to stop. The product spec encodes this distinction visually in
§11.5 (the `⊘` cancelled symbol, run status shown as `(paused)` not `✕`) and
§6.6 (failure reserves `✕`; ctrl-c does not). Until the type definition
reflects reality, any code that pattern-matches on `RunResult.status` will
silently misclassify aborted runs as failed. The fix is a one-token addition to
the union in §4.9.

---

## Before / after — §4.9 The Runner

**File:** `_specs/pipelinekit-tech_spec.md`
**Heading:** `### 4.9 The Runner`
**Location:** the `RunResult` type block, approximately line 886.

### BEFORE

```ts
type RunResult = {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
};
```

### AFTER

```ts
type RunResult = {
  runId: string;
  runDir: string;
  status: 'succeeded' | 'failed' | 'aborted';
  cost: { totalUsd: number; totalTokens: number };
  artifacts: string[];
  durationMs: number;
};
```

The surrounding context (the `Runner` class block above and "Execution algorithm"
below) is unchanged.

---

## Cross-link insertions

### Insertion 1 — tech spec §4.9, after the RunResult block

**File:** `_specs/pipelinekit-tech_spec.md`
**Position:** insert after the closing `};` of the `RunResult` type, before the
line that begins "Execution algorithm (single-process, in-memory DAG walker):"

**Insert this sentence (as a prose paragraph):**

```
`status: 'aborted'` is set when the run is interrupted by an abort signal or
ctrl-c before any step raises an error. It is distinct from `'failed'`: the run
made progress and state is saved; the user can resume. See product spec §6.6 for
the failure display (which uses `✕`) and §11.5 for the ctrl-c / paused display
(which uses `⊘` and the `(paused)` banner label).
```

---

### Insertion 2 — product spec §11.5, after the code block

**File:** `_specs/relay-product_spec.md`
**Heading:** `### 11.5 What happens on ctrl-c`
**Position:** insert after the closing ` ``` ` of the verbatim example block,
before the sentence "Ctrl-c is not an error."

**Insert this sentence:**

```
The Runner sets `RunResult.status` to `'aborted'` for this outcome — never
`'failed'`. See tech spec §4.9 for the type definition.
```

---

## Why now

`runner.ts` has emitted `'aborted'` since the abort-signal work landed (lines
258, 453, 986 in the current file). The type on `RunResult` still says
`'succeeded' | 'failed'`. Any caller that exhaustively switches on `status`
today has a silent dead branch or a TypeScript error once the type is corrected.
Task 101 adds a policy layer that reads `RunResult.status`; that work assumes
`'aborted'` is a recognized value in the spec. Applying this amendment first
keeps the spec, types, and implementation aligned before the policy layer lands.
