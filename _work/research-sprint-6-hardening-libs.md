# Sprint 6 — Hardening Library Evaluation

Scope: three library decisions that gate the rest of the sprint.

- **(a)** Retry with backoff + jitter + predicate for provider calls (task_97).
- **(b)** StateMachine.save() serialization (task_96).
- **(c)** Progress-display file watcher for `<runDir>/live/*.json` (next sprint; documented here so it is not re-litigated).

Data collected 2026-04-19 from `registry.npmjs.org`, `api.npmjs.org/downloads`, GitHub, and bundlephobia. Weekly downloads are the week ending 2026-04-18.

Constraints that shape every decision:

- Node ≥ 20.10, ESM only.
- Core returns `Result<T, E>` via neverthrow. Any adopted library must be wrappable at a thin boundary that catches thrown errors and folds them into `err(...)`. Throwing inside core is not allowed.
- "Healthy balance" rule: adopt a dep for genuinely complex logic; keep in-tree for patterns we already ship and understand.

---

## (a) Retry with exponential backoff + jitter + predicate

Requirements recap:

- `maxRetries + 1` total attempts.
- Exponential backoff with jitter.
- `shouldRetry(err)` predicate; short-circuits `TimeoutError`, `ClaudeAuthError` (domain-generic: `SubscriptionAuthError`), `FlowDefinitionError`, `HandoffSchemaError`.
- `ProviderRateLimitError` (added in task_95) should retry with a longer base delay.
- Compose with neverthrow — retry wrapper is the marked throw/catch boundary; the outer signature stays `Result<T, E>`.

### Candidates at a glance

| Metric | `p-retry` 8.0.0 | `async-retry` 1.3.3 | Bespoke |
|---|---|---|---|
| Last publish | 2026-03-26 | 2021-08-17 | — |
| Weekly downloads | ~35.0M | ~22.1M | — |
| Repo issues / PRs | 1 / 0 | 20 / 10 | — |
| Minified bytes (bundlephobia) | 4,349 | 4,009 | ~40–60 LOC |
| Gzipped bytes | 1,767 | 1,471 | — |
| Runtime deps | 1 (`is-network-error`) | 1 (`retry@0.13.1`) | 0 |
| Transitive deps | 1 | 1 (unmaintained since 2021) | 0 |
| Engines | node ≥ 22 ⚠ | node ≥ 14.16 | node ≥ 20.10 |
| ESM-native | ✓ | ✕ (CJS) | ✓ |
| TypeScript types | ✓ (first-party) | ✓ (via `@types/async-retry`) | ✓ |
| License | MIT | MIT | — |
| Maintainer | sindresorhus (active) | vercel (stale) | us |

### Feature fit

| Feature | `p-retry` | `async-retry` | Bespoke |
|---|---|---|---|
| Exponential backoff | ✓ `factor` | ✓ `factor` | build |
| Jitter | ✓ `randomize` | ✓ `randomize` (default true) | build |
| `minTimeout` / `maxTimeout` | ✓ | ✓ | build |
| `maxRetryTime` total budget | ✓ | ✕ | build if needed |
| Custom predicate | ✓ `shouldRetry(err, context)` | partial — `bail(err)` inside the operation | trivial |
| Don't-consume-budget predicate | ✓ `shouldConsumeRetry` | ✕ | build if needed |
| `onFailedAttempt` hook | ✓ | ✓ `onRetry` | build |
| `AbortController` signal | ✓ | ✕ | trivial |

### Neverthrow composition

Both libraries are throw-based. The `Result` boundary is a thin wrapper around the call:

```ts
// pseudocode — wrap provider calls at the retry boundary
const attempt = (): Promise<T> =>
  providerCall().then((r) => r.isOk() ? r.value : Promise.reject(r.error));

return pRetry(attempt, {
  retries: maxRetries,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 30_000,
  randomize: true,
  shouldRetry: (err) => isRetryable(err),
}).then(ok, (err) => err(normalize(err)));
```

Both libraries let us keep `Result<T, E>` at the exported surface. `p-retry`'s `shouldRetry(err, context)` is a closer fit to our requirement than `async-retry`'s in-operation `bail(err)` (which forces the predicate to live inside the attempt closure, making it harder to unit-test independently).

### Risks

| Risk | `p-retry` | `async-retry` | Bespoke |
|---|---|---|---|
| Engines field says node ≥ 22, we target ≥ 20.10 | ⚠ real — see mitigation below | ✕ none | ✕ none |
| Stale upstream | ✕ active | ⚠ no release since 2021; depends on `retry@0.13.1` (also 2021) | ✕ we own it |
| Dep on `is-network-error` / `retry` | adds one transitive | adds one transitive (unmaintained) | 0 |
| Hidden behaviour to learn | small — documented options | small — but `bail` ergonomics are awkward | we write docs |
| Subtle bugs we author ourselves | ✕ | ✕ | ⚠ jitter math is easy to get subtly wrong |

### `p-retry` engines caveat

`p-retry@8` declares `engines.node >= 22`. Relay targets node ≥ 20.10. Two paths:

1. **Pin `p-retry@7.x`** — last 7.x line declared `node >= 18` and is still on npm; v8 raised it to 22 in March 2026. We lose `shouldConsumeRetry` and the AbortSignal integration improvements but keep `shouldRetry`, `onFailedAttempt`, backoff+jitter, `maxRetryTime`. This is the safe pick.
2. **Raise our floor to node 22** — not aligned with the sprint plan.

Task_97 should pin the 7.x line and document the version in `packages/core/package.json`. The API we need (`shouldRetry` predicate, backoff+jitter options) is stable across 7 and 8.

### Decision

**Recommendation: adopt `p-retry` (pinned to 7.x while our node floor is 20.10).**

Rationale:

- Retry + exponential backoff + jitter + `shouldRetry(err, context)` + `maxRetryTime` + `onFailedAttempt` is meaningfully complex and error-prone to hand-roll. This is exactly the "genuinely complex logic" bucket from the healthy-balance rule.
- Active maintenance, ~35M weekly downloads, MIT, one tiny transitive dep.
- Clean neverthrow boundary at the retry wrapper — the rest of core stays `Result`-typed.
- `async-retry` is a non-starter here: upstream is stale (no release since 2021), depends on `retry@0.13.1` (also stale), and its `bail`-based API is a worse fit for an externally-defined predicate. It would work, but we would inherit a dead dependency tree.
- Bespoke is tempting (~40 LOC) but the bug surface (jitter math, cancellation interaction, total-budget accounting, AbortSignal wiring) is not zero and we gain nothing we cannot get from a 1,767-byte gzipped dep.

Open question for task_97: confirm the `p-retry` 7.x pin satisfies task_97 requirements (specifically whether `shouldConsumeRetry` is needed for `ProviderRateLimitError` — if yes, we either raise node or implement that bit in the wrapper).

---

## (b) StateMachine.save() serialization

Requirements recap:

- Serialize concurrent `StateMachine.save()` calls so two writers never race on the same `state.json` path.
- No cross-process coordination needed — same assumption as `HandoffStore`.
- Must compose with `Result<void, E>` return values.

### The in-tree pattern

`packages/core/src/handoffs.ts` already ships this pattern for handoff writes:

- `HandoffStore` holds `#writeLocks: Map<string, Promise<Result<void, WriteError>>>`.
- Each `write(id, ...)` chains onto the tail promise for that id, replaces the map entry with the new tail, and clears the entry in `finally` only if it is still the tail.
- Final state is last-writer-wins with no torn files (atomic rename is the second line of defense).
- Readers are not blocked; cross-process concurrency is out of scope.

This is ~15 lines of logic, already tested in sprint earlier, and already returns `Result`. StateMachine.save() has the same shape: single id (the run's `state.json`), same `atomicWriteJson` under the hood, same single-process assumption.

### Candidates at a glance

| Metric | `p-queue` 9.1.2 | `p-limit` 7.3.0 | Reuse in-tree pattern |
|---|---|---|---|
| Last publish | 2026-04-07 | 2026-02-03 | — |
| Weekly downloads | ~23.0M | ~242.2M | — |
| Repo issues | 2 | 0 | — |
| Minified bytes | 8,287 | 1,700 | ~15 LOC |
| Gzipped bytes | 3,096 | 887 | — |
| Runtime deps | 2 (`eventemitter3`, `p-timeout`) | 1 (`yocto-queue`) | 0 |
| Engines | node ≥ 20 | node ≥ 20 | — |
| ESM-native | ✓ | ✓ | ✓ |
| Extras beyond mutual exclusion | priority, interval rate-limit, pause/start, onIdle, timeout | just concurrency | — |

### Feature fit for StateMachine.save()

For a `concurrency: 1` single-resource mutex, both libraries work; `p-limit` at `concurrency: 1` is literally a FIFO mutex over a single key. `p-queue` is the bigger hammer — its priority/interval/pause/onIdle surface is all dead weight for our use case.

### Composition with Result

Both libraries wrap thunks and return whatever the thunk returns. Since our thunk returns `Promise<Result<void, E>>`, the outer Promise carries the same `Result`. No throws to catch, no semantics lost. This is genuinely trivial either way.

### Why the in-tree pattern wins here

- **We already ship it.** `HandoffStore.#writeLocks` is production code, reviewed, tested, and handles the same single-key-mutex problem in exactly the shape we need.
- **StateMachine.save() is a degenerate case.** Only one id (`state.json` per run). The Map can be a single promise-cell; even lighter than HandoffStore. Realistically 8–10 lines.
- **Zero deps** versus one or two transitive deps for a feature we've already implemented.
- **Same mental model across the codebase.** A reviewer looking at `handoffs.ts` and then `state.ts` sees the same idiom; a mixed world (`Map<id, Promise>` here, `p-limit` there) is cognitive friction for a 15-line pattern.
- **The healthy-balance rule says exactly this.** Complex logic → adopt a dep. Pattern we already have working → keep in-tree.

### Decision

**Recommendation: keep in-tree — reuse the `HandoffStore.#writeLocks` pattern in `StateMachine`.**

Rationale:

- The pattern is already in-tree, tested, and ~15 lines.
- `p-queue` brings priority/interval/timeout/pause semantics we do not need, at 2 transitive deps.
- `p-limit` is a closer fit but a 1.7KB dep for 10 lines of code we already wrote elsewhere is the shape of "glue library creep."
- Keeping one idiom across both state files is better for reviewers than introducing a second one.

Guidance for task_96: extract the pattern into a small helper (e.g., `util/serialize.ts`) so `HandoffStore` and `StateMachine` share it rather than each hand-rolling the promise-tail chain. The helper stays in-tree; no new dep.

Open question for task_96: if StateMachine ever needs to write more than one file per run (e.g., per-step `live/*.json`), the helper should be keyed (like HandoffStore's `Map<id, Promise>`), not a single promise cell. Ask the task author which shape is correct.

---

## (c) Progress-display file watcher (next sprint)

Context (not built this sprint):

- Watches `<runDir>/live/<stepId>.json` — one file per step, low file count, small payloads.
- macOS + Linux only at launch (no Windows).
- Files are written via atomic rename (`atomicWriteJson` — temp file then rename over the target). This is the hard case for watchers: editors and our own atomic writer both produce rename-style updates.

### Candidates at a glance

| Metric | `chokidar` 5.0.0 | raw `fs.watch` |
|---|---|---|
| Last publish | 2025-11-25 | Node core |
| Weekly downloads | ~158.3M | — |
| Repo open issues | 29 | — |
| Minified bytes | 21,540 | 0 |
| Gzipped bytes | 7,779 | 0 |
| Runtime deps | 1 (`readdirp`) | 0 |
| Engines | node ≥ 20.19 | node ≥ 20.10 (matches our floor) |
| ESM-native | ✓ | ✓ |
| v4 removed globs | yes — `ignored` takes a predicate now | n/a |
| Handles rename-over-target reliably | ✓ (smoothed internally) | ⚠ fires `rename` event; `filename` may be null; watch handle may detach |
| Debounces duplicate events | ✓ `awaitWriteFinish`, internal coalescing | ✕ raw |
| Cross-platform event shape | ✓ normalized | ✕ different event names per OS |

### The atomic-rename trap

`fs.watch` fires `rename` on the watched path when a file is replaced via rename-over-target (what `atomicWriteJson` does). On Linux, the watch often attaches to the original inode and stops receiving events after the first rename. On macOS, `filename` is sometimes null and coalescing is inconsistent. Our own writer triggers this case on every step update.

`chokidar` handles this — it re-attaches to the path, coalesces duplicate events, and exposes a single `change` event regardless of platform. The 2024 v4 rewrite dropped the legacy polyfills and is now a thin layer over `fs.watch` + `fs.watchFile` with the fixes we actually want.

### Decision

**Recommendation: adopt `chokidar` for the subsequent sprint's watcher. Do not adopt in this sprint (no code consumes it yet).**

Rationale:

- `fs.watch` has documented reliability issues on both our target platforms (macOS filename reliability; Linux inode reattachment after rename). Our write pattern (atomic rename) specifically triggers the worst cases.
- chokidar v4 is small (~7.8KB gzipped), actively maintained (latest release Nov 2025), 1 transitive dep, ESM-native, and does exactly the smoothing we need.
- Bespoke `fs.watch` smoothing is a classic "easy to start, hard to finish" path — the bug reports will come from the exact edge cases (rename, fast writes, editor saves on config files) that chokidar already solved.

Open question for the next sprint: chokidar v4 requires node ≥ 20.19. Our current floor is 20.10. Either raise the floor in the sprint that adopts chokidar or pin chokidar to v3.x (which still supports node ≥ 8 but carries more deps). Recommendation: bump the floor to 20.19 when we adopt — it's a trivial bump and v4 is the better library.

---

## Summary of decisions

| Question | Decision | One-line why |
|---|---|---|
| (a) retry | **adopt `p-retry@^7`** | Retry+backoff+jitter+predicate is complex enough to earn a 1.7KB gzipped, actively-maintained dep. Pin 7.x until we raise node to 22. |
| (b) state save serialization | **keep in-tree** | We already ship the single-key mutex pattern in `HandoffStore`; extract to a shared helper — no new dep. |
| (c) file watcher | **adopt `chokidar@^5` (next sprint)** | `fs.watch` is unreliable exactly where atomic rename writes it; chokidar solves that for 7.8KB. |

## Open questions for downstream tasks

1. **task_95 / task_97**: does `ProviderRateLimitError` need `shouldConsumeRetry` (the "don't burn a retry slot for this error" option, added in p-retry 8)? If yes, we need to either (a) raise node to 22, (b) implement that logic in our wrapper, or (c) decide rate-limited retries are best-effort and use the same budget. Default assumption: (b) is fine; rate-limit hits are rare and counting them is defensible.
2. **task_96**: is `StateMachine.save()` single-file or will it grow to per-step files? Shapes the helper signature (single cell vs keyed map).
3. **Next sprint (watcher)**: confirm we can bump node floor to 20.19 before adopting chokidar v4.
