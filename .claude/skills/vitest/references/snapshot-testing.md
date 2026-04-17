# Snapshot Testing

Snapshots are the right tool for CLI output that has to match a spec example byte-for-byte. They're the wrong tool for fast-changing data structures.

## When to use

- **CLI banners** — pre-run, success, failure, doctor, splash help. These match product spec §6.X verbatim.
- **Generated artifact templates** — HTML report headers, scaffolded README skeletons.
- **Error message formatting** — the `formatError(err)` output for each error class.

## When NOT to use

- **Internal data structures** — RunState, StepMetrics shape. Use explicit `expect(x.field).toBe(...)` so the test names what matters.
- **Anything with a timestamp / runId / cost / duration** — they change every run. Either inject deterministic values, or assert structurally.
- **Multi-line files where you don't care about exact bytes.** Use `expect(text).toContain(...)` or parse and assert.

## Inline snapshots — the default

```ts
import { renderStartBanner } from '../src/banner.js';

it('matches the §6.3 pre-run banner format', () => {
  const out = renderStartBanner({
    flow: { name: 'codebase-discovery', version: '0.1.0' },
    runId: 'f9c3a2',
    auth: { ok: true, billingSource: 'subscription', detail: 'max via OAuth' },
    input: { repoPath: '.', audience: 'both' },
    costEstimate: { min: 0.30, max: 0.50 },
    stepCount: 5,
    etaMin: 12,
    nowIso: '2026-04-17T14:32:00Z',   // injected for determinism
  });

  expect(out).toMatchInlineSnapshot(`
    "●─▶●─▶●─▶●  relay

    flow     codebase-discovery v0.1.0
    input    .  (audience=both)
    run      f9c3a2  ·  2026-04-17 14:32
    bill     subscription (max)  ·  no api charges
    est      $0.40  ·  5 steps  ·  ~12 min

    press ctrl-c any time — state is saved after every step.
    ───────────────────────────────────────────────────────"
  `);
});
```

**Inline snapshots win over file snapshots** because:

- Reviewable in the test file directly.
- Diff-friendly in PRs.
- Self-documenting — you read the test and see what's asserted.

The cost: long snapshots make the test file unwieldy. Threshold: if the snapshot is over ~30 lines, switch to a file snapshot.

## File snapshots

```ts
expect(out).toMatchSnapshot();
// Stored at tests/__snapshots__/<file>.test.ts.snap
```

Commit `__snapshots__/`. Reviewers see them in the PR diff.

## Updating snapshots

```bash
pnpm test -u                    # update all snapshots
pnpm test -u banner             # only files matching "banner"
```

Run after intentional output changes. NEVER `-u` blindly — read the diff first.

## Determinism — the hard part

Snapshots fail when output is non-deterministic. To stabilize:

### Inject the clock
```ts
function renderStartBanner(args, { nowIso = new Date().toISOString() } = {}) {
  // use nowIso instead of new Date()
}
```

In tests, pass `nowIso: '2026-04-17T14:32:00Z'`.

### Inject the runId
```ts
function startRun(opts: { runId?: string }) {
  const runId = opts.runId ?? randomShortId();
  // ...
}
```

In tests, pass `runId: 'f9c3a2'`.

### Strip ANSI for color-output snapshots
```ts
import stripAnsi from 'strip-ansi';
expect(stripAnsi(coloredOut)).toMatchInlineSnapshot(`...`);
```

Or render with colors disabled in the test:
```ts
process.env.NO_COLOR = '1';
const out = render();
delete process.env.NO_COLOR;
```

Cleaner: the visual.ts module reads a config we can set per-test.

### Round / fix numerics
For cost or duration in snapshots, either fix them via injection or strip them with a regex:
```ts
const stable = out.replace(/\d+\.\d+s/g, 'X.Xs').replace(/\$\d+\.\d+/g, '$X.XX');
expect(stable).toMatchInlineSnapshot(`...`);
```

## Reviewing snapshot diffs in PRs

When a snapshot changes, the question is always: **is this a regression or an intentional change?**

- If intentional (new feature, banner redesign): the PR description should call it out, and the diff should be the entire change.
- If unintentional: the test caught a bug. Fix the source, don't `-u` the snapshot.

A PR that only updates snapshots with no source changes is suspicious — flag it in review.

## Anti-patterns

- **Don't snapshot data with timestamps.** Always inject the clock.
- **Don't snapshot things you don't read.** A snapshot you never look at is dead code that fails to catch regressions.
- **Don't put assertions inside snapshots.** Snapshots are exact-equality. If you only care about a substring, use `expect(x).toContain(...)`.
- **Don't snapshot binary data.** Snapshots are text-based; binary will diff badly.
