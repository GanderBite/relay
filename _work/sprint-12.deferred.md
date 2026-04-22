# Sprint 12 · Deferred Review Findings

Each entry was marked `fix later` in `_work/sprint-12.code_review.md`. Open as future sprint tasks.

## BLOCK-1 · Telemetry `status` field drifts from spec vocabulary

- **Severity:** BLOCK
- **File:** `packages/cli/src/telemetry.ts:35`, `packages/cli/src/commands/run.ts:298,323`
- **Section:** tech spec §8.4
- **Why deferred:** Small problem as long as it works properly; user accepted the current behavior.
- **Suggested fix:** Change `RunEvent.status` to `'succeeded' | 'failed' | 'aborted'`. Update both `maybeSendRunEvent` call sites in `run.ts` to pass `result.status` directly (`'succeeded'` for the success branch, `result.status === 'aborted' ? 'aborted' : 'failed'` for the failure branch).

## FLAG-8 · No unit tests for any sprint-12 code (lint, registry, telemetry, publish)

- **Severity:** FLAG
- **File:** `packages/cli/tests/`
- **Section:** CLAUDE.md — test-engineer Vitest tests using MockProvider
- **Why deferred:** Tests will be added in a later sprint.
- **Suggested fix:** Open a sprint-13 task covering: (a) `lintFlowPackage` with a temp-dir fixture producing each specific error/warning code, (b) `generateRegistryJson` with a mocked `execFile` for the npm-view path and a temp dir for the local path, (c) `isEnabled` + `maybeSendRunEvent` with env stubbing and a mocked `fetch`, (d) `publishCommand` with mocked `execFile` and `lintFlowPackage` to assert step order.
