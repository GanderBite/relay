# Sprint 1 · Core Foundation Primitives — Code Review Findings

**Reviewer:** `@code-reviewer (agent)`
**Reviewed files (current state on disk):**

- `packages/core/src/errors.ts`
- `packages/core/src/util/atomic-write.ts`
- `packages/core/src/logger.ts`
- `packages/core/src/zod.ts`
- `packages/core/src/providers/types.ts`
- `packages/core/src/index.ts` (re-exports for above only)

**Scope note:** Files have been rewritten by later sprints (neverthrow integration, pino migration, Zod v4 idioms, Result-flip on providers, etc.). Findings reflect compliance with the tech spec AND the post-sprint-4 accepted policy decisions: boundary rule (`@relay/core` returns `Result`, client-facing layers throw), `InvocationRequest.jsonSchema: Record<string, unknown>`, `InvocationResponse.costUsd` optional, `toolUseId` on tool events, `ProviderRegistry.register/get` returning `Result`, `AuthState.ok` retained for back-compat.

**Summary:** 2 BLOCK, 8 FLAG, 10 PASS.

For each finding below, fill in the `Decision` field with one of:

- **fix now** — patch in a follow-up wave before closing the sprint
- **fix later** — accept for now, open a task for a later sprint
- **wont fix** — finding noted, no change (give reason)
- **needs spec** — requires spec amendment; escalate

---

## BLOCK · 2

### BLOCK-1 · `Logger` does not carry flow/run/step context — defeats §4.10's event shape

- **File:** `packages/core/src/logger.ts:3-19` and `packages/core/src/providers/types.ts:154`
- **Spec:** §4.10 — every `LogEvent` must include `flowName: string; runId: string; stepId?: string; event: string`. "`Logger` is a class so flow authors can replace it (e.g., to ship events to a remote sink)." §4.6.3 — `InvocationContext.logger: Logger` is how the Runner hands a scoped logger to providers.
- **Finding:** The current logger is a single module-level `pino()` instance re-exported as both a value and a type alias (`typeof Logger`). It has no `child(bindings)` wiring for `flowName` / `runId` / `stepId`, no per-run file destination, and no factory. `InvocationContext.logger: Logger` therefore always resolves to the same global instance — a provider cannot tell from a log line which run/step it served. The only site that uses `ctx.logger.debug` today (`providers/claude/provider.ts:224`) passes `{ stepId, attempt }` as event data by hand; that pattern will not survive a real Runner implementation that needs `bindings` applied automatically. The module also exposes no `LogEvent` type even though §4.10's first sentence defines one.
- **Suggested fix:** Provide (a) a typed `LogEvent` type export, and (b) a factory like `createLogger({ runId, flowName, logFile? })` that returns a pino instance with `bindings` pre-populated, plus a helper the Runner calls per-step (`logger.child({ stepId })`). Keep the module a thin wrapper over pino — no bespoke formatting. Update `InvocationContext.logger`'s type to the factory's return type so providers receive the scoped logger, not the global singleton.
- **Decision:** fix now - option b

### BLOCK-2 · `Logger` pino config ships `pino-pretty` transport in production — wrecks NDJSON log files and cannot be disabled without editing this file

- **File:** `packages/core/src/logger.ts:10-18`
- **Spec:** §4.10 — "Per-run log at `<runDir>/run.log` — newline-delimited JSON events … No structured-log library dependency. Plain `JSON.stringify` writes to a `WriteStream`." The intent is machine-readable NDJSON to file and optional human-readable prettifying to stdout only when a TTY.
- **Finding:** The default pino config unconditionally routes every log record through the `pino-pretty` worker-thread transport, regardless of whether stdout is a TTY or whether the caller wants NDJSON. That means: (1) the per-run log file `run.log` that §4.10 mandates cannot be produced by this logger — the pretty transport emits ANSI-colored, human-readable lines, not NDJSON; (2) `pino-pretty` spawns a Node worker thread on every import, adding startup cost and a second exit path the Runner has to drain; (3) there is no way for a caller to opt into raw JSON output short of re-constructing pino themselves, which defeats the point of re-exporting a shared instance; (4) the `NO_COLOR` env var only toggles color, not the transport. `LOG_LEVEL` is also the only configurability — no programmatic knob. Under §4.10's `logFile` requirement the output has to be parseable NDJSON.
- **Suggested fix:** Default to raw NDJSON on stdout (plain `pino()` with no transport). When the factory is called with `console: true` AND `process.stdout.isTTY`, layer `pino-pretty` via `pino.multistream` or a destination, not the global transport. File logs (`logFile`) go to a second destination writing raw NDJSON. This also addresses BLOCK-1's file-destination gap.
- **Decision:** fix now. Can we check NODE_ENV if it's production skip pino-pretty and only keep it when NODE_ENV is development.

---

## FLAG · 8

### FLAG-1 · `ProviderCapabilityError`'s class docstring is attached to `toFlowDefError` instead

- **File:** `packages/core/src/errors.ts:162-171`
- **Spec:** §8.2 — `ProviderCapabilityError extends FlowDefinitionError` and is surfaced to the user as a flow-load error; the docstring "Thrown at flow-load time when a step requests a capability the configured provider does not support. Extends `FlowDefinitionError` so the CLI maps it to exit code 2." obviously describes the class, not the helper.
- **Finding:** Lines 162-166 carry a JSDoc block whose text ("Thrown at flow-load time when a step requests a capability …") describes `ProviderCapabilityError`, but the next declaration is `export function toFlowDefError(...)`. `ProviderCapabilityError` itself (line 171) has no class docstring at all. Reading the file, `toFlowDefError` appears to be the class being documented. This is a copy-paste or reorder artifact — the helper was injected between the docstring and the class it documents.
- **Suggested fix:** Move the class above `toFlowDefError`, or move the docstring down so it sits directly above `export class ProviderCapabilityError`. Add a one-liner doc to `toFlowDefError` describing what it actually does ("Wrap a Zod parse error into a `FlowDefinitionError` with a prettified message.").
- **Decision:** fix now, let's go with the suggested fix

### FLAG-2 · `ProviderAuthError` has no documented exit code — §8.2 table does not include it, so the CLI has no mapping

- **File:** `packages/core/src/errors.ts:149-160`
- **Spec:** §8.2 "The CLI maps these to exit codes: 0 success, 1 StepFailureError, 2 FlowDefinitionError, 3 ClaudeAuthError, 4 HandoffSchemaError, 5 TimeoutError." No row for `ProviderAuthError`.
- **Finding:** `ProviderAuthError extends PipelineError` directly. It is neither a `ClaudeAuthError` nor a `FlowDefinitionError`, so `instanceof` dispatch in the CLI exit-code mapper will fall through to the generic `PipelineError` case (most likely exit 1 — "generic step failure"). That contradicts the intent: an auth misconfiguration in a non-Claude provider is the same user-facing category as §8.2's exit-3 "auth / environment error." This is a spec gap that the sprint-1 code inherits, but the error class itself is where the CLI's `instanceof` chain is built. Today `ProviderAuthError` has no class JSDoc stating what exit code it should map to, so the CLI author has no guidance.
- **Suggested fix:** Either (a) have `ProviderAuthError extends ClaudeAuthError` so the exit-3 mapping falls through cleanly (but note the name collision with Claude-specific error — not ideal), or (b) amend §8.2 to add an exit code for `ProviderAuthError` (most likely 3, re-naming the category to "provider auth / environment error"), or (c) map it to a dedicated exit code. Until §8.2 is amended, add a JSDoc note to this class pointing at the gap.
- **Decision:** fix now - opt b

### FLAG-3 · `PipelineError.code: string` is wider than `ErrorCode` — unknown codes slip through

- **File:** `packages/core/src/errors.ts:21, 24`
- **Spec:** §8.2 "`code: string // machine-readable`". The sprint task says `code:string`. But the module also defines `ERROR_CODES` and `ErrorCode` union (lines 4-14).
- **Finding:** `PipelineError.code` is typed `string`, which matches the tech spec literally. However, the module has an `ErrorCode` union covering the seven sanctioned codes, and every built-in subclass passes one of those constants. Typing the public field as plain `string` means `err.code === 'random_typo'` typechecks; the CLI cannot rely on exhaustive switch narrowing. This is a minor footgun at the API boundary.
- **Suggested fix:** Tighten to `readonly code: ErrorCode` on `PipelineError`, and have the constructor accept `ErrorCode` too. Subclasses already only pass the constants, so this is a type-only change. If future provider-error extensions need custom codes, widen via a union literal (`ErrorCode | \`${string}_${string}\``) rather than falling back to raw `string`.
- **Decision:** fix now - suggested fix is correct

### FLAG-4 · `atomicWriteText` cleanup path discards the `rm` error — inverted silence

- **File:** `packages/core/src/util/atomic-write.ts:20-24`
- **Spec:** §4.2 / §8.5 — "On error, clean up temp file" (task_7). The contract is: write failure should surface, and the temp file cleanup should not mask it.
- **Finding:** The intent is correct (always reject with `originalError`), but the structure is doubly-folded and tricky to read: `orElse` swallows both the successful `rm` and the failed `rm` into the same `Promise.reject(originalError)`, using `ResultAsync.fromSafePromise<void>(Promise.reject(originalError))` as an `err(originalError)` equivalent. Two issues: (1) `fromSafePromise` with a rejecting promise is an anti-pattern — the function name says "safe" but it wraps a rejection, relying on neverthrow internals to turn the rejection into an `err`; `errAsync(originalError)` is the canonical form. (2) If the `rm` cleanup itself throws (permission denied, cross-device), that error is completely discarded — a stale `.tmp-<uuid>` file is left on disk with no surfaced signal. The caller never learns the temp file still exists.
- **Suggested fix:** Replace the `orElse` chain with the idiomatic form:
  ```ts
  return writeAndRename.orElse((originalError) =>
    ResultAsync.fromPromise(
      rm(tempPath, { force: true }),
      () => originalError,
    ).andThen(() => errAsync(originalError)),
  );
  ```
  Log the `rm` error at `warn` level before discarding if BLOCK-1's logger factory lands.
- **Decision:** fix now, suggested fix is correct

### FLAG-5 · `atomicWriteText` does not fsync — crash window between write and rename can leak zero-byte files

- **File:** `packages/core/src/util/atomic-write.ts:13-25`
- **Spec:** §4.2 "temp + rename pattern". §8.5 "state.json, handoffs/\*.json, metrics.json, live-state files". Crash-safety is the reason these writes are atomic.
- **Finding:** `fs.writeFile` returns before the OS has flushed data to disk. `fs.rename` is atomic at the directory entry level but does not imply durability. A power-loss or kernel crash between `writeFile` resolving and the rename landing on stable storage can leave `path` pointing to a zero-byte or partially-written inode on ext4 with `data=writeback`. For the files §8.5 lists (handoffs the next prompt step reads, state the resumer reads after a crash), that defeats the crash-safety contract. POSIX-grade atomic write = `fsync(fd)` on the temp fd, `rename`, optionally `fsync` on the parent dir. The current code does neither.
- **Suggested fix:** Open the temp file via `fs.open`, `writeFile` through the handle, call `handle.sync()` (fdatasync) before `handle.close()`, then `rename`. Optionally `fsync` the parent directory (needed on ext4 for maximum durability; Windows and HFS+ do not expose it). Balance: fsync adds ~1-10ms per write; for handoffs and state this is fine, for a high-frequency `metrics.json` append path it may matter.
- **Decision:** fix now. suggested fix is correct

### FLAG-6 · `atomicWriteText` does not guard against cross-device rename (EXDEV)

- **File:** `packages/core/src/util/atomic-write.ts:14, 18`
- **Spec:** §4.2 / §8.5 — the rename is the atomicity primitive.
- **Finding:** `<path>.tmp-<uuid>` is placed in the same directory as `path` (via `dirname(path)` for mkdir and the template literal for the tmp path), which on the happy path keeps the rename on the same filesystem. But if `path` is a symlink pointing into a different filesystem, or if the caller passes a path on a mounted overlay (`.pipelinekit/runs/<id>` under a bind-mounted runs dir is a realistic pattern), `rename()` fails with `EXDEV`. The current code propagates that as a generic Error with no context for the caller to fall back to a copy-then-rename strategy.
- **Suggested fix:** On `EXDEV`, fall back to: copy temp → final dest with `cp` semantics (which is no longer atomic, but is at least recoverable) and log a warning. Alternatively, document that both paths must be on the same filesystem, and surface a typed `AtomicWriteError` that carries the `code` from the underlying NodeJS.ErrnoException.
- **Decision:** fix now. I don't know how often this can happen. Atomic writes are crutial for the pipelines to work. Without artifacts rest of steps will fail so we need some way to handle retrying.

### FLAG-7 · Logger has no secret scrubbing — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` values can land in log files verbatim

- **File:** `packages/core/src/logger.ts` (entire file)
- **Spec:** §8.1 — the whole point of the billing-safety guard is to prevent the API key from being touched in the run path. The companion skill `.claude/skills/billing-safety/SKILL.md` treats any place that could log the key as a threat-model leaf.
- **Finding:** pino's `redact` option is not configured. If a downstream caller passes `{ env: process.env }` or an error object whose stack or message contains the key to `logger.debug('...', data)`, it goes into the NDJSON run log in plaintext. Run logs are committed to issue trackers, uploaded for support, and shipped to the catalog for debugging — every one of those is a key-leak path. Even if sprint-1's scope is "just re-export pino," the re-export IS the shared logger; there is no second layer that adds redaction.
- **Suggested fix:** Configure `pino({ redact: { paths: ['*.ANTHROPIC_API_KEY', '*.CLAUDE_CODE_OAUTH_TOKEN', '*.headers.authorization', 'env.ANTHROPIC_API_KEY', 'env.CLAUDE_CODE_OAUTH_TOKEN'], censor: '[redacted]' } })`. Coordinate paths with the env allowlist list in `providers/claude/env.ts`. Add a unit test that feeds an env object with a fake key and asserts the log line does not contain it.
- **Decision:** fix now - library must be secure so no evns can leak anywhere.

### FLAG-8 · `zod.ts` re-export is narrower than the tech-spec contract — `ZodSchema`, `ZodIssue`, `Infer` aliases dropped

- **File:** `packages/core/src/zod.ts:1`
- **Spec:** task_9 (sprint-1 JSON): "export type { ZodSchema, ZodIssue, ZodTypeAny, infer as Infer } from 'zod'". §8.3 "library re-exports `z` for convenience."
- **Finding:** The module is now a single line `export { z } from 'zod'`. Downstream code reaches for `z.ZodType`, `z.core.$ZodIssue`, `z.prettifyError`, `z.infer`, `z.custom` through the `z` namespace, which works in Zod v4. Dropping the separate type aliases matches the Zod v4 idiom (v4 recommends `z.ZodType<T>` over `ZodSchema<T>`, and `z.core.$ZodIssue` over the old `ZodIssue`), so this is a deliberate sprint-post-task_9 simplification that tracks the `zod-v4` skill. The finding is: the sprint-1 task spec still names four type aliases, but the landed code ships only the namespace import, and there is no test or README snippet confirming the new surface is the intentional contract. A flow author reading the public API surface sees `z` only and must know to reach for `z.ZodType` — there is no TypeDoc example.
- **Suggested fix:** Keep the single-line re-export (it's the right call for Zod v4). Add a short JSDoc block above `export { z }` documenting the intended patterns: `z.ZodType<T>` for generic schema parameters, `z.infer<typeof X>` for inference, `z.core.$ZodIssue` for handoff issue arrays. Mirror the list in `index.ts`'s comment at line 83.
- **Decision:** spec was written keeping zod v3 in mind. We are upgrading to zod v4 that changed how zod works marking a lot of things from v3 as deprecated. As long as it is compliant with zod v4 we can leave it as is.

---

## PASS · 10

- `errors.ts`: every class in §8.2 + §4.2 is present (`PipelineError`, `FlowDefinitionError`, `StepFailureError`, `ClaudeAuthError`, `HandoffSchemaError`, `TimeoutError`, `ProviderAuthError`, `ProviderCapabilityError`). `name` is set on every subclass. `Error.captureStackTrace(this, new.target)` is called in every constructor. Fields match the spec: `stepId`/`attempt` on `StepFailureError`, `handoffId`/`issues` on `HandoffSchemaError`, `stepId`/`timeoutMs` on `TimeoutError`, `providerName` on `ProviderAuthError`, `providerName`/`capability` on `ProviderCapabilityError`.
- `ERROR_CODES` constant exports seven stable string codes with the `relay_` prefix (matching the rebrand from `pipelinekit_`). `ErrorCode` union type is derived via `(typeof ERROR_CODES)[keyof typeof ERROR_CODES]`.
- `toFlowDefError` helper correctly wraps `z.core.$ZodError` via `z.prettifyError` — uses the Zod v4 idiom.
- Errors module is pure — does not throw, `defineFlow` and step builders already consume it via `Result<_, FlowDefinitionError>`.
- `atomicWriteJson` pretty-prints with 2-space indent + trailing newline and delegates to `atomicWriteText` — good composition.
- `atomicWriteText` uses `mkdir({ recursive: true })`, `randomUUID()` for the temp suffix, `rename` atomically. Does not mutate input data. Does not throw — returns `ResultAsync<void, Error>` per the boundary rule.
- `providers/types.ts` matches §4.6.1–§4.6.4 on every interface field (all nine `ProviderCapabilities` fields, all five `AuthState` fields, all seven `InvocationRequest` fields, all nine `InvocationResponse` fields, all four `NormalizedUsage` fields, all six `InvocationContext` fields, all six `InvocationEvent` variants).
- `providers/types.ts` applies all four post-sprint-4 policy decisions faithfully: `jsonSchema: Record<string, unknown>` (line 128), `costUsd?: number` (line 176), `toolUseId?` on `tool.call` and `tool.result` (lines 208/213), `Provider.authenticate`/`invoke` return `Promise<Result<_, PipelineError>>` (lines 259, 268). `AuthState.ok` retained with a JSDoc note explaining it is for back-compat (lines 62-67). `Provider.stream` stays `AsyncIterable<InvocationEvent>` — generator bodies are the one approved no-throw exception.
- `index.ts` re-exports the full error hierarchy (all eight classes + `ERROR_CODES` + `ErrorCode` + `toFlowDefError`), both atomic-write helpers, `Logger`, `z`, and every sprint-1 provider type (`AuthState`, `CostEstimate`, `InvocationContext`, `InvocationEvent`, `InvocationRequest`, `InvocationResponse`, `NormalizedUsage`, `Provider`, `ProviderCapabilities`). Neverthrow primitives (`err`, `ok`, `errAsync`, `okAsync`, `fromPromise`, `fromSafePromise`, `fromThrowable`, `Result`, `ResultAsync`) are re-exported for consumer convenience, matching the no-throw boundary contract.
- No file in sprint-1 scope contains spec refs (`§4.2`, etc.) or sprint/task IDs in code comments — matches the user-memory "self-contained comments" discipline.

---

## Other follow-ups (out of sprint-1 scope)

- `state.ts:168` still has a `throw new PipelineError(...)` in `loadState`'s stale-schema path — it is the last remaining throw in `@relay/core` outside of generator bodies and `handoffs.ts` (which also throws at lines 19, 42). Both are sprint-3 files. Flag for a sprint-3-revisit task to flip them to Result — the boundary rule was adopted mid-sprint-4 and these files predate it.
- `handoffs.ts:19, 42` throw `HandoffSchemaError` directly instead of returning `err(...)` — same cleanup as above.
- `providers/registry.ts` throwing was called out as FLAG-20 in sprint-4; confirmed fixed in current state (returns `Result<_, FlowDefinitionError>` at lines 10 and 19).
- `template.ts:123, 155` throw `FlowDefinitionError`. The surrounding parser is sync so a Result flip is mechanical; same sprint-3 follow-up.
- `Provider.estimateCost` returns bare `Promise<CostEstimate>` (line 277) rather than `Promise<Result<CostEstimate, PipelineError>>`. Under the strict boundary rule this is a third exception to the no-throw policy alongside generator bodies. Either (a) wrap in `Result` for consistency, or (b) document it as an approved exception in the boundary-rule language. Noted here because the contract lives in sprint-1's `providers/types.ts` but the decision is cross-sprint.
- `logger.ts` re-export approach is consistent with the user-memory "thin re-exports over bespoke wrappers" guidance, but the file as-shipped is too thin to satisfy §4.10's `LogEvent` + `child` + per-run-file contract — see BLOCK-1/BLOCK-2. The right middle ground is 15-25 lines per the user memory: a factory + a few bindings.
