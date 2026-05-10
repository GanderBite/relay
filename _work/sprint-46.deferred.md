# Sprint 46 · Deferred Review Findings

Each entry was marked `fix later` in `_work/sprint-46.code_review.md`. Open as future sprint tasks.

## FLAG-2 · Ask step inside a `loop` body would crash the run rather than pause it cleanly

- **Severity:** FLAG
- **File:** `packages/core/src/flow/steps/loop.ts:50-52`, `packages/core/src/orchestrator/orchestrator.ts:1289-1318, 1462-1510`
- **Section:** Decision A enumerates `step.ask` as a kind. The loop body switch in `loop.ts:50-52` accepts `'ask'` as a body step kind, signalling that ask-in-loop is a supported configuration. There is no explicit decision against it in A-G.
- **Why deferred:** User chose option 2 — properly support ask-in-loop. Substantially more work than the safe sprint-46 reject-at-compile-time fix; a follow-up sprint task.
- **Suggested fix:** Surface the loop step id (not the body step id) on the `AwaitingInputSignal` carry, or seed body-step state entries on demand so `StateMachine.pauseStep` can record the pause against a known step. Either approach must keep the resume path intact: on resume the loop's body must re-enter at the paused body step with the answer handoff visible. Add round-trip tests modelled on `tests/orchestrator/ask-pause-resume.test.ts` but with the ask step inside a loop body that runs at least one iteration before pausing.
