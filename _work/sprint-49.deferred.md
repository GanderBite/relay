# Sprint 49 · Deferred Review Findings

Each entry was marked `fix later` (or interpreted as such from the finding body) in `_work/sprint-49.code_review.md`. Open as future sprint tasks.

## FLAG-1 · Several graph/ sub-modules exceed their listed line caps

- **Severity:** FLAG
- **File:** `packages/core/src/flow/graph/cycle.ts` (122 / 120), `graph/roots.ts` (54 / 40), `graph/context-from.ts` (95 / 80), `graph/ask-questions.ts` (167 / 100), `graph/compose.ts` (157 / 150)
- **Section:** A.3
- **Why deferred:** User decision: "this is already an improvement good enough for me." The cycle/roots/context-from/compose overruns are within ~20% of the cap and not worth churn.
- **Suggested fix:** Split `ask-questions.ts` (167 lines) into `ask-question-sources.ts` (validateAskQuestionSources + the dotted-handoff loop-body helper, ~85 lines) and `parallel-ask-quota.ts` (validateParallelAskQuota + collectLoopBodyAsks, ~80 lines), and update `compose.ts:6` to import from both. Leave the smaller overruns in place.

<!-- FLAG-11 was deferred initially but later addressed: see commit that introduces packages/cli/tests/commands/_run-harness.ts and _resume-harness.ts. -->

