# Sprint 21 · Deferred Review Findings

Each entry was marked `fix later` in `_work/sprint-21.re-review.md`. Open as future sprint tasks.

## re-review-FLAG-1 · config action _opts prefix contradicts forwarding intent

- **Severity:** FLAG
- **File:** `packages/cli/src/commands/config.ts:144,182,214`
- **Section:** Code quality / forwarding contract consistency
- **Why deferred:** fix later — no behavior change; current code is correct, just the `_` prefix implies the parameter will never be used, which contradicts the intent of Finding-4's opts-forwarding fix.
- **Suggested fix:** Rename `_opts: Record<string, unknown> = {}` to `opts: Record<string, unknown> = {}` in `listAction`, `getAction`, and `setAction`. Optionally add a one-line comment on the first action noting that opts are forwarded from Commander for future use. One-character change per parameter, no behavior change.
