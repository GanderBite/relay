# Sprint 13 · Deferred Review Findings

Each entry was marked `fix later` in `_work/sprint-13.code_review.md`. Open as future sprint tasks.

## FLAG-5 · `ClaudeCliProvider.invoke` omits `costUsd` when `total_cost_usd` is absent — documentation asymmetry with SDK provider

- **Severity:** FLAG
- **File:** `packages/core/src/providers/claude-cli/provider.ts:313-331, 359-369`; `packages/core/src/providers/claude/provider.ts:330-333`
- **Spec:** Tech spec §4.6.3 rule 3: "`costUsd` is the API-equivalent estimate."
- **Why deferred:** User wants to remove cost calculations from Relay entirely. The asymmetry between CLI and SDK providers for `costUsd` should be resolved as part of that larger cost-removal effort rather than patched in isolation now.
- **Suggested fix:** When the cost-removal sprint lands, delete `costUsd` from `InvocationResponse` entirely and scrub all cost-tracking paths from both providers, the Runner, and the CLI banners. Until then, the asymmetry is a documentation concern only — behaviour is correct per spec and no billing is affected.
