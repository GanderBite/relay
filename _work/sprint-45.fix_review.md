# Sprint 45 — Fix-Wave Re-Review

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** fix-wave commits `630afc0` (BLOCK-1), `15429aa` (FLAG-1, FLAG-5), `88a8d76` (FLAG-2, FLAG-4), `8790ae6` (FLAG-3, FLAG-6)
**Cumulative diff:** `630afc0~1..HEAD`

---

### BLOCK-1 — Branch executor never resolves structured env / drops RELAY_* / skips run templating

- **Verdict:** RESOLVED
- **Evidence:** `630afc0` · `packages/core/src/orchestrator/exec/branch.ts:1-155` · `BranchExecContext` extended with `input`/`handoffs`/`flowDir`/`handoffsDir` (lines 18-29); `step.run` rendered via `renderTemplate` for both array and string forms (lines 54-69); `resolveScriptEnv` invoked with the same context shape as `executeScript` (lines 86-92); RELAY_RUN_DIR/FLOW_DIR/HANDOFFS_DIR/INPUT_JSON injected (lines 109-114) with the documented merge order `baseEnv < relayEnv < resolved.value` (line 119); best-effort `${stepId}.input.json` dump via `atomicWriteText(...).unwrapOr(undefined)` (lines 100-107). Orchestrator dispatch threads the new fields at `orchestrator.ts:1188-1204` symmetrically with the script branch. Four new branch-executor tests in `tests/orchestrator/exec/branch.test.ts` cover `from: 'input.x'`, required-missing, RELAY_RUN_DIR injection, and string-form `{{input.x}}` templating — all green.

### FLAG-1 — `resolve: 'absolute'` silently ignored at runtime

- **Verdict:** RESOLVED
- **Evidence:** `15429aa` · `packages/core/src/orchestrator/exec/script-env.ts:87-95` · Added explicit `else if (resolveMode === 'absolute')` branch that returns `err(new FlowDefinitionError(...))` when `!isAbsolute(value)`. Decision option (b) — enforcement variant — implemented as written, preserving the documented API surface. New tests `[ENV-012]` (absolute path passes through), `[ENV-013]` (relative path returns FlowDefinitionError), and `[ENV-014]` (fromCwd still works) confirm the runtime contract.

### FLAG-2 — `resolveScriptEnv` failure loses `FlowDefinitionError` cause chain

- **Verdict:** RESOLVED
- **Evidence:** `88a8d76` · `packages/core/src/orchestrator/exec/script.ts:94-100` and `packages/core/src/orchestrator/exec/branch.ts:93-98` · Both executors now attach `cause: resolved.error` on the `StepFailureError` `details` payload. `StepFailureDetails.cause: unknown` was already declared in `errors.ts:120`, so no type contract drift. New tests `[EXEC-SCRIPT-ENV-CAUSE]` and the matching branch test assert `err.details?.cause` is a `FlowDefinitionError` instance.

### FLAG-3 — `dry-run` calls `resolveScriptEnv` once per env entry without explanation

- **Verdict:** RESOLVED
- **Evidence:** `8790ae6` · `packages/cli/src/commands/dry-run.ts:111` · Added a single explanatory comment `// Resolve per entry so a single failure produces one placeholder, not a wholesale skip.` immediately before the per-entry loop, matching decision option (a) verbatim. No behavior change.

### FLAG-4 — Best-effort input JSON dump always runs

- **Verdict:** NO-OP CONFIRMED
- **Evidence:** `88a8d76` · `packages/core/src/orchestrator/exec/script.ts:104-110` · The unconditional `atomicWriteText` call for `${stepId}.input.json` is unchanged. The only edit in this file in the fix wave was the FLAG-2 cause-preserve (lines 94-100). Per user decision "Keep as is", this is the intended outcome.

### FLAG-5 — Builder validation does not reject `from: 'input.'` (empty suffix after prefix)

- **Verdict:** RESOLVED
- **Evidence:** `15429aa` · `packages/core/src/flow/steps/script.ts:37-42` and `packages/core/src/flow/steps/branch.ts:37-42` · After the prefix-startsWith check, both builders compute `prefix` and reject `value.from.length <= prefix.length` with a `FlowDefinitionError`. Test suite `step-builders.test.ts` adds eight new cases (`[ENV-BUILD-001..004]` for script, `[ENV-BUILD-010..013]` for branch) covering `'input.'`, `'handoff.'`, valid suffix, and the error message text — all pass.

### FLAG-6 — `dry-run` builds `RELAY_INPUT_JSON` path manually with raw `/` instead of `path.join`

- **Verdict:** RESOLVED
- **Evidence:** `8790ae6` · `packages/cli/src/commands/dry-run.ts:143` · Replaced the template-literal path construction with `join(envCtx.runDir, 'live', \`${step.id}.input.json\`)`. This now matches the executor's path construction at `script.ts` and `branch.ts` byte-for-byte on every platform. `join` was already imported at the top of the file, so no new import surface.

---

## NEW FINDINGS

None. The fix wave introduced no new BLOCK or FLAG conditions.

Verification checks performed:
- `pnpm -F @ganderbite/relay-core typecheck` — clean.
- `pnpm -F @ganderbite/relay typecheck` — clean.
- `pnpm -F @ganderbite/relay-core test --run tests/orchestrator/exec/{branch,script,script-env}.test.ts tests/flow/step-builders.test.ts` — 66 / 66 pass.
- The two pre-existing failing tests (`[ABORT-001]` SIGINT mid-run, `state-save-failure`) are timing-sensitive flakes that pass when run in isolation; both predate the fix wave and are noted in the original review's "Other follow-ups". Not introduced by these commits.
- Brand-grammar: no emojis, no "simply", no trailing exclamation marks, no banned old nouns ("flow"/"step"/"handoff" in the user-visible sense — these are correct domain terms now per sprint 19).
- Billing safety: RELAY_* injection in `branch.ts` mirrors the `script.ts` discipline; `ANTHROPIC_API_KEY` is not introduced into the env passed to the subprocess.
- Neverthrow discipline: no new `throw` in core outside the existing `StepFailureError` contract; `resolveScriptEnv` continues to return `Result`.

---

```
Fix-wave verdict counts: 6 RESOLVED · 0 PARTIAL · 0 REGRESSED · 1 NO-OP · 0 new BLOCK · 0 new FLAG
```
