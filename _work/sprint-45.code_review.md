# Sprint 45 — Templated scripts + declared env sources — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed:** commits `f253d82` (feat(core): introduce ScriptEnvValueSpec discriminated union for structured env declarations), `8455016` (feat(core): structured env validation, runtime resolver, and run argv templating), `836e4ea` (feat(core): wire resolveScriptEnv into executor and inject RELAY*\* auto-vars), `a269606` (feat(cli): surface resolved env and RELAY*\_ vars in relay dry-run), `a22c924` (test(core): cover ScriptEnvValueSpec, resolveScriptEnv, run templating, RELAY\_\_ injection)
**Summary:** 1 BLOCK, 6 FLAG, 9 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## BLOCK · 1

### BLOCK-1 — Branch executor never resolves structured env, drops `from:` entries, skips RELAY\_\* injection and run-argv templating

- **File:** `packages/core/src/orchestrator/exec/branch.ts:42-58`
- **Spec / sprint goal:** Sprint 45 goal — \_"Script steps support structured env declarations with `from:` source pointers, `{{input.x}}` templating in env values and run argv, and auto-injected RELAY\_\_ vars."\* Task 74 widened **both** `ScriptStepSpec.env` AND `BranchStepSpec.env` (via the schema update on line 103 of `flow/schemas.ts`) to accept `ScriptEnvValueSpec`. Task 75 added flow-load prefix validation **in `branch.ts` builder as well as `script.ts` builder**. So the surface contract for branch steps now accepts `{ from: 'input.x', required: true }` — but the runtime executor silently drops every non-string entry.
- **Quote (current branch.ts):**
  ```ts
  const stepEnv: Record<string, string> = Object.fromEntries(
    Object.entries(step.env ?? {}).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v]] : [],
    ),
  );
  const env: Record<string, string> = { ...baseEnv, ...stepEnv };
  ```
- **Finding:** This stub was added in wave-1 commit `f253d82` as a placeholder _"until the resolver lands"_ (per the commit body), but the resolver wiring in wave 3 (commit `836e4ea`) only touched `executeScript`. As a result, **branch steps**:
  1. **Silently drop `{ from: 'input.x' }` entries** — author writes `env: { REPO: { from: 'input.repo', required: true } }` on a branch step, parses cleanly through `branchStep` builder, then at runtime `REPO` is simply absent from the child env. `required: true` is never enforced.
  2. **Receive no RELAY_RUN_DIR / RELAY_FLOW_DIR / RELAY_HANDOFFS_DIR / RELAY_INPUT_JSON.** The skill doc at `.claude/skills/flow-package-format/SKILL.md:120` claims _"Every script step receives these four environment variables"_ — branch steps run scripts too (per `BranchExecContext` in branch.ts and the orchestrator dispatch on `orchestrator.ts:1188-1196`), and the BranchStepSpec extends ScriptStepSpec, so authors will reasonably expect parity.
  3. **Do not template `step.run`.** A branch step with `run: 'check.sh {{input.repo}}'` will execute the literal string. The `executeScript` change in `script.ts:70-72` does not exist in `branch.ts:27`.
  4. **The orchestrator dispatch at `orchestrator.ts:1188-1196` does not even pass `input`/`handoffs`/`flowDir`/`handoffsDir` into `BranchExecContext`** — those fields don't exist on `BranchExecContext` either. So even if the executor wanted to resolve, it has no inputs to do so.

  This is a discriminated-union API where one half of the union (script) is fully wired and the other half (branch) silently drops half its declared shape. Authors get no error at flow load, no error at runtime — just a silently missing env var that may surface as a misrouted exit-code branch. For required env vars that's a billing/correctness hazard.

- **Suggested fix:** Either:
  - **(a) Wire branch.ts to `resolveScriptEnv` symmetrically.** Extend `BranchExecContext` with `input/handoffs/flowDir/handoffsDir`, render `step.run` via `renderTemplate`, call `resolveScriptEnv`, inject the four RELAY*\* vars, dump `${stepId}.input.json`, and follow the same merge order `baseEnv < RELAY*\* < resolved`. This is the natural completion of the sprint goal. Update `orchestrator.ts:1188-1196`to thread the same fields it already threads into`executeScript`.
  - **(b) If the sprint intentionally scopes only to script steps**, reject the new env form on branch steps in the `branchStep` builder with a clear `FlowDefinitionError` so authors get a load-time signal instead of a silent runtime drop. But this contradicts task_74's schema change (`branchStepSpecSchema` already accepts `scriptEnvValueSpecSchema`) and task_75's prefix validation (which currently runs in `branch.ts` for nothing).

  Option (a) is the right answer — the BranchStepSpec extending ScriptStepSpec implies symmetric runtime support.

- **Decision:** fix now. Option (a)

---

## FLAG · 6

### FLAG-1 — `resolve: 'absolute'` is permitted by the type and schema but the runtime resolver silently ignores it

- **File:** `packages/core/src/orchestrator/exec/script-env.ts:85-87`
- **Spec:** Task 74 declares `ScriptEnvResolve = 'fromCwd' | 'absolute'`. The skill doc (`flow-package-format/SKILL.md:118`) says _"`'absolute'` (treat as already absolute). Default unset — value is used verbatim."_
- **Quote:**
  ```ts
  if (resolveMode === "fromCwd") {
    value = resolve(process.cwd(), value);
  }
  ```
- **Finding:** Setting `resolve: 'absolute'` and leaving `resolve` unset are observationally identical — both pass the value through verbatim. There's no validation that the value is actually absolute. This means `'absolute'` is documentation-only; it conveys author intent but the runtime never enforces or even checks it. Two failure modes that should produce errors silently succeed:
  1. `{ from: 'input.path', resolve: 'absolute' }` where `input.path` is a relative path → no warning, the relative path is used as-is.
  2. The variant is part of a stable API surface, so future-tightening (e.g. throwing when `'absolute'` is set with a relative value) would be a breaking change.

  The product spec is silent on `resolve: 'absolute'`. Either drop the value from `ScriptEnvResolve` (making it `'fromCwd' | undefined` only) or make the runtime enforce `path.isAbsolute(value)` and `err(FlowDefinitionError)` when not. Currently the variant is dead.

- **Suggested fix:** Add an explicit branch: `else if (resolveMode === 'absolute' && !isAbsolute(value)) return err(new FlowDefinitionError(\`env key "${key}": resolve: 'absolute' but value "${value}" is not absolute\`))`. Alternatively, simplify the type to `ScriptEnvResolve = 'fromCwd'` and drop the schema enum.
- **Decision:** fix now.

### FLAG-2 — `resolveScriptEnv` failure surfaces as `StepFailureError` with no cause chain, losing the `FlowDefinitionError` type

- **File:** `packages/core/src/orchestrator/exec/script.ts:96-98`
- **Spec:** Task 78 — _"`resolveScriptEnv` failure throws `StepFailureError`, not `FlowDefinitionError`."_ — that's followed. But the resolver returns a typed `FlowDefinitionError` for two semantically different conditions (required-missing source, unrecognized prefix), and both get flattened to a `StepFailureError` whose details only carry `runId`.
- **Quote:**
  ```ts
  if (resolved.isErr()) {
    throw new StepFailureError(resolved.error.message, stepId, attempt, {
      runId,
    });
  }
  ```
- **Finding:** The original `FlowDefinitionError` instance is discarded; only its message survives. The CLI exit-code mapper that distinguishes `FLOW_DEFINITION` (exit 2) from `STEP_FAILURE` (exit 1) won't fire. For an unrecognized-prefix case this is arguably wrong — the prefix is a load-time programmer error that escaped the builder validation only because runtime resolution discovered it (e.g. bad data in handoff). For a required-missing case, surfacing as a step failure is defensible (it's an input issue, not a definition issue). The task spec did say "throw StepFailureError" without nuance, so this matches the literal task wording, but it loses information.
- **Suggested fix:** Either preserve the cause via `StepFailureError`'s `details` field — `{ runId, cause: resolved.error }` — or split: rethrow the `FlowDefinitionError` for `unrecognized from prefix` (a programming error) and wrap the `required-missing` case as `StepFailureError`. The simplest fix is to attach the cause: `{ runId, cause: resolved.error }`. This costs nothing and lets diagnostic tooling inspect the original.
- **Decision:** fix now. perserve the cause

### FLAG-3 — `dry-run` calls `resolveScriptEnv` once per env entry, multiplying work by N entries

- **File:** `packages/cli/src/commands/dry-run.ts:111-135`
- **Spec:** Task 79 — _"Call resolveScriptEnv. For any resolution failure, print KEY=<unresolvable: <from>> instead of failing."_
- **Quote:**
  ```ts
  for (const [k, spec] of Object.entries(rawEnv)) {
    if (isScriptEnvFromSpec(spec)) {
      const singleResult = resolveScriptEnv({ [k]: spec }, envCtx);
      ...
    } else {
      const singleResult = resolveScriptEnv({ [k]: spec }, envCtx);
      ...
    }
  }
  ```
- **Finding:** The function is called once per env entry on a single-entry map, just so per-entry failures don't short-circuit the others. It's correct and the cost is trivial in dry-run, but the design is confusing — readers will wonder why a function that takes a `Record<string, ScriptEnvValueSpec>` is invoked on a one-key map. The simpler shape is to inline the per-entry resolution (a few lines that mirror `resolveOne` from `script-env.ts`), or to expose `resolveOne` (or a `resolveOneEntry`) from the core module.
- **Suggested fix:** Either (a) accept this as a deliberate "fail-soft per entry" idiom and add a one-line comment explaining why we don't call `resolveScriptEnv(rawEnv, envCtx)` once (because the first error short-circuits the rest), or (b) export a `resolveScriptEnvEntry(key, spec, ctx)` helper from core and use that. Option (a) costs zero — a comment like `// Resolve per entry so a single failure produces one placeholder, not a wholesale skip.`
- **Decision:** fix now. option (a)

### FLAG-4 — Best-effort input JSON dump always runs, even when no script step references `RELAY_INPUT_JSON`

- **File:** `packages/core/src/orchestrator/exec/script.ts:104-107`
- **Spec:** Task 78 — _"Write `ctx.input` to `<runDir>/live/<stepId>.input.json` as JSON (best-effort, `await atomicWriteText(...).unwrapOr(undefined)`)."_
- **Quote:**
  ```ts
  const inputJsonPath = join(runDir, "live", `${stepId}.input.json`);
  await atomicWriteText(
    inputJsonPath,
    `${JSON.stringify(ctx.input, null, 2)}\n`,
  ).unwrapOr(undefined);
  ```
- **Finding:** Every script step now writes a fresh JSON file under `<runDir>/live/` regardless of whether anything reads it. For flows with many script steps and large inputs this adds disk churn, and `JSON.stringify` on a large input may briefly stall the event loop. It's also harmless in the common case. Worth flagging because the spec text says "scripts can read structured input via $RELAY_INPUT_JSON" — that's an opt-in feature, but the cost is paid unconditionally.
- **Suggested fix:** Either accept as-is (the cost is small and the file is useful for post-run debugging too — it captures what input the step saw), or gate the write on whether `step.env` references `RELAY_INPUT_JSON` or whether the step has been authored to read it (impossible to detect without scanning the run command, which is brittle). Simplest: keep as-is and document in the SKILL.md that the file is always written. Already documented; no change needed.
- **Decision:** fix now. Keep as is.

### FLAG-5 — `dotPath` returns `undefined` for empty path string but the resolver only validates prefix, not suffix

- **File:** `packages/core/src/orchestrator/exec/script-env.ts:20-28, 58-63`
- **Spec:** Task 76 — _"Dot-path: `'input.foo.bar'` → `ctx.input['foo']['bar']`. Stop at `undefined` without throwing."_ Task 75 builder validates that `from` _starts with_ `input.` or `handoff.` but does not check there's a non-empty suffix.
- **Quote (script-env.ts):**
  ```ts
  if (from.startsWith("input.")) {
    const suffix = from.slice("input.".length);
    resolved = dotPath(ctx.input, suffix);
  }
  ```
- **Finding:** A bare `from: 'input.'` (with trailing dot, empty suffix) passes the builder's prefix check, then `dotPath(ctx.input, '')` calls `''.split('.')` which yields `['']` (a single empty segment), then accesses `ctx.input['']` which is virtually always undefined → resolves to undefined → either empty string (not required) or `FlowDefinitionError` (required). The behavior is defensible (it bottoms out cleanly) but masks what's clearly an authoring typo. Same for `from: 'input'` (no dot at all) — that would fail the prefix check (good), but `from: 'input.'` won't.
- **Suggested fix:** Tighten the builder validation in `flow/steps/script.ts:32` and `branch.ts:32`: `if (!value.from.startsWith('input.') && !value.from.startsWith('handoff.'))` → also require that `value.from.length > 'input.'.length` (or `'handoff.'.length`). Throw `FlowDefinitionError` with `env key "${key}": from "${value.from}" must include a non-empty path after the prefix`. Cheap; turns an obscure runtime miss into a load-time error.
- **Decision:** fix now.

### FLAG-6 — `dry-run` builds `RELAY_INPUT_JSON` path manually, diverging from the executor's actual path

- **File:** `packages/cli/src/commands/dry-run.ts:142`
- **Spec:** Task 79 — \_"Auto-injected RELAY\_\_ vars are listed with their computed paths."\*
- **Quote:**
  ```ts
  ['RELAY_INPUT_JSON', `${envCtx.runDir}/live/${step.id}.input.json`],
  ```
- **Finding:** This duplicates the path construction from `script.ts:104` (`join(runDir, 'live', \`${stepId}.input.json\`)`). On Windows, the dry-run output would use forward slashes and the executor would use mixed separators (`path.join`returns OS-native). Two divergences are possible: (1) future change to the executor's path layout that doesn't propagate here; (2) different separator on non-POSIX. Since`dry-run`'s `runDir`is the literal placeholder`'<runDir>'`, the divergence is mostly cosmetic, but on Windows the displayed path would diverge from real runs.
- **Suggested fix:** Export a small helper from core — e.g. `relayInputJsonPath(runDir, stepId)` colocated with `script.ts` — and import it from both places. Or use `path.join` here too: `join(envCtx.runDir, 'live', \`${step.id}.input.json\`)`. Cheap consistency win.
- **Decision:** fix now.

---

## PASS · 9 (no action needed)

For transparency, one bullet per area summarizing what works.

- `packages/core/src/flow/types.ts`: `ScriptEnvValueSpec` discriminated union, `ScriptEnvFromSpec` interface with `required`/`resolve` flags, and the `isScriptEnvFromSpec` type guard are exactly the shapes task 74 promised. `ScriptStepSpec.env` is widened to `Record<string, ScriptEnvValueSpec>` and `BranchStepSpec` inherits via `Omit`. Backward-compat string form survives — type guard returns false for strings.
- `packages/core/src/flow/schemas.ts`: `scriptEnvValueSpecSchema` is a clean `z.union([z.string(), z.strictObject({...})])` — strict object rejects unknown keys, both `script` and `branch` schemas accept the new form. Backward-compat `env: { KEY: 'value' }` parses with no schema changes.
- `packages/core/src/flow/steps/script.ts` & `branch.ts`: Builder-side from-prefix validation (`'input.' | 'handoff.'`) fires synchronously at flow load via `FlowDefinitionError`. Type guard correctly narrows. Both files mirror each other. Comment-doc on `isScriptEnvFromSpec` is self-contained — no spec refs in TS source per the project's code-comment rule.
- `packages/core/src/orchestrator/exec/script-env.ts`: `resolveScriptEnv` returns `Result<Record<string, string>, FlowDefinitionError>`, never throws. All four error paths use `err(...)` (required-missing-undefined, required-missing-null, unrecognized-prefix, template render fail bubbled from `renderTemplate`). String values flow through `renderTemplate`. `dotPath` is null-safe and never throws.
- `packages/core/src/orchestrator/exec/script.ts` (executor wiring): `executeScript` calls `resolveScriptEnv`, injects RELAY\_\* with documented merge order `baseEnv < relayEnv < resolved.value` so step env wins (line 119, with explanatory comment). `renderTemplate` is applied to both string and array `run` forms before `splitShell`. Render failure surfaces as `StepFailureError`. RELAY_INPUT_JSON dump is best-effort via `unwrapOr(undefined)` — confirmed by [EXEC-SCRIPT-009] test.
- `packages/core/src/orchestrator/orchestrator.ts:1171-1187`: Dispatch site threads `input`, `handoffs: {}`, `flowDir`, and `handoffsDir: join(runDir, 'handoffs')` into the script `executeScript` call. The `handoffs: {}` empty record is acknowledged in a comment as a future enhancement — sensible scoping.
- `packages/cli/src/commands/dry-run.ts`: Imports `resolveScriptEnv` and `ScriptEnvContext` from the re-exported core surface (no deep imports). `<from: input.x>` placeholder for unresolvable spec, real value when input is supplied. Secret redaction (`token/secret/key/password`) still applies to the user-supplied env entries (the RELAY\_\* row uses `dim` and isn't redacted, which is fine since the values are paths, not secrets).
- `packages/core/src/index.ts`: Re-exports `ScriptEnvFromSpec`, `ScriptEnvResolve`, `ScriptEnvValueSpec`, `isScriptEnvFromSpec`, `resolveScriptEnv`, `ScriptEnvContext`. Surface is consistent — types exported from `flow/types.js`, runtime API from `orchestrator/exec/script-env.js`.
- Tests (`tests/orchestrator/exec/script-env.test.ts` + 3 new cases in `script.test.ts`): 17 resolver tests cover the discriminated union, schema, dot-path, required, prefix validation, multi-key short-circuit, undefined env. Three executor tests cover string-template `run`, RELAY*RUN_DIR injection, and step-env-overrides-RELAY*\*. Backward-compat case `env: { KEY: 'literal' }` is covered by `[SCHEMA-ENV-002]`. Mixed map by `[SCHEMA-ENV-003]`. All sprint-45 tests pass; the single failing test in the suite (`[ABORT-001]` SIGINT timeout) predates this sprint and is unrelated.
- `packages/generator/templates/linear/flow.ts` + `.claude/skills/flow-package-format/SKILL.md`: Linear template gains a commented structured-env block. SKILL.md adds a clean "Script steps — env declarations and auto-injected vars" section with `ScriptEnvFromSpec` field table and RELAY*\* table. No emojis, no banned words ('simply' / trailing `!`), no spec section refs in author-facing prose. Both files only document; no functional code touched. Auth/billing safety check: RELAY*\* names cannot collide with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` — different namespace prefix.

---

## Other follow-ups (out of sprint-45 scope)

- The `tests/orchestrator/orchestrator.test.ts > [ABORT-001] SIGINT mid-run` test times out at 10 s on this machine. Pre-existing, unrelated to sprint 45. Worth investigating in a maintenance sprint — the test is racy or the SIGINT-handling path has changed under it.
- Step ids are validated only as `nonEmptyString` (`packages/core/src/flow/schemas.ts:17`). They flow into filesystem paths like `<runDir>/live/<stepId>.input.json`, `<runDir>/live/<stepId>.stderr.txt`, etc. A step id containing `..` or `/` could traverse outside `live/`. This is not a sprint-45 regression — the existing executor has the same exposure for stderr sidecars — but worth a separate task to tighten the regex (e.g. `/^[a-zA-Z][a-zA-Z0-9_-]*$/`).
- `BranchExecContext` does not include `input`/`handoffs`/`flowDir`/`handoffsDir`. Even if BLOCK-1 is fixed, the branch dispatch path in `orchestrator.ts:1188-1196` needs to thread those fields through. Flag for the BLOCK-1 fix wave.
