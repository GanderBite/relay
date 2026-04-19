# Research: CLI Output Libraries for Sprint 7

**Task:** task_107  
**Date:** 2026-04-19  
**Gates:** tasks 42 / 43 / 44 / 45 / 46 / 47 / 48 / 77

---

## 1. `commander` — confirm version, evaluate `cac` alternative

### What is already declared

`packages/cli/package.json` pins `commander` at `13.1.0`. The latest stable release is
`14.0.3` (published 2026-02-21). Both versions support Node ≥ 20, ship an ESM
entry (`esm.mjs`), and include TypeScript declarations. The CJS fallback exists for
compatibility but the ESM path is the one Relay will use.

### Should we switch to `cac`?

`cac` (v7.0.0, published 2026-02-27) is an ESM-only, zero-dep CLI argument parser.
Unpacked size is ~41 KB versus commander's ~209 KB. It ships its own `dist/index.d.ts`.

However, `cac` is not worth switching to for these reasons:

- **Subcommand depth.** Relay needs nested subcommands (`relay run`, `relay resume`,
  `relay doctor`, `relay install`, etc.). `commander` has first-class subcommand
  support with per-subcommand help, action handlers, and option inheritance. `cac`
  supports subcommands but its API is thinner and less battle-tested at this depth.
- **Ecosystem adoption.** `commander` is used by tens of thousands of npm packages and
  is the standard reference for "how does this CLI library work." When a contributor
  opens `packages/cli/src/`, they already know commander's API.
- **Version mismatch is the only action needed.** The pinned version `13.1.0` should
  be bumped to `14.0.3` in the next dependency-update pass. There is no breaking
  change to evaluate at this point — the `14.x` changelog only adds minor features
  and Node 20 engine tightening.

**Recommendation:** keep `commander`, upgrade pin from `13.1.0` to `14.0.3`.

---

## 2. `chalk` vs `picocolors`

### Color needs (from product spec §4.3)

The full set of color requirements is:

| Spec value | ANSI requirement |
|---|---|
| Green (completed step, auth OK) | `green` |
| Yellow (in-flight, warning, API mode) | `yellow` |
| Red (failure, broken auth) | `red` |
| Gray / dim (pending, metadata) | `dim` or `gray` |
| Bold (status label, key values) | `bold` |

That is five named styles. No background colors, no 256-color palette, no truecolor
gradients, no `italic`, no `strikethrough`. The set is fixed and small.

### Library comparison

| Property | chalk 5.6.2 | picocolors 1.1.1 |
|---|---|---|
| Unpacked size | 44 KB | 6.4 KB |
| Dependencies | 0 | 0 |
| ESM | yes (pure ESM) | yes (pure ESM) |
| `NO_COLOR` support | yes | yes |
| TTY auto-detection | yes, via `chalk.level` | yes, respects `process.stdout.isTTY` |
| `--no-color` flag wiring | manual, via `chalk.level = 0` | manual |
| Styles needed | all present | all present |
| API surface | chainable: `chalk.green.bold(s)` | functions: `pc.green(pc.bold(s))` |

Both libraries cover the full color set from §4.3. Both respect `NO_COLOR`. The
difference is ergonomics and size, not capability.

`chalk`'s chainable API is friendlier for composing multiple styles in one
expression: `chalk.dim.bold('·')`. `picocolors` requires nesting:
`pc.dim(pc.bold('·'))`. With five styles and the symbol vocabulary from §5 used
throughout the CLI, the calling code is the same order of magnitude either way.

The 38 KB size difference is negligible in a Node.js CLI that already pulls in the
TypeScript runtime, commander, and core workspace packages.

**Recommendation:** `chalk 5.x`. The chainable API reads more cleanly when combining
`dim` + `bold` (the `gray` secondary-text case used in nearly every command output).
The size delta is immaterial. Chalk is also the more likely choice for any future
contributors to already understand, reducing onboarding friction.

Note: `NO_COLOR` and TTY detection must be wired explicitly in the visual-identity
module (task_77). When `process.env.NO_COLOR` is set or `--no-color` is passed, set
`chalk.level = 0` before any output. When stdout is not a TTY, set `chalk.level = 0`
and fall back to the plain-text log format in §6.4.

---

## 3. TTY progress display strategy

### Requirement summary (product spec §6.4, §11)

- Three zones: **header** (one line, static), **step grid** (one line per step,
  redraws in place), **footer** (two lines, always visible).
- Spinner frames tick in place; the grid must not scroll.
- No progress bars, no percentages, no celebration characters (§11.4).
- Plain text, Unicode symbol vocabulary only.
- Non-TTY fallback: one newline-delimited JSON log line per state transition (§6.4).

The primary UX is a stable N-line block that updates in place — fixed-height,
re-rendered every spinner tick or step state change.

### Library evaluation

**`listr2` (v10.2.1, 135 KB)**

Listr2 is an opinionated task-runner UI that renders a vertical list of named tasks
with spinners. Its rendering model — one row per "task", built-in log capture, nested
subtasks — superficially resembles the step grid. However:

- Listr2 owns the layout. It renders step names, spinners, and per-task logs via its
  own layout engine. Overriding that layout to match §6.4's exact column format
  (symbol · name · model · turn · tokens · cost) would require fighting the library's
  renderer rather than using it.
- Its built-in "footer" concept does not match the two-line footer in §11.2.
- The `log-update` v6 it bundles is older than the standalone v7 we would use.
- Listr2 adds `eventemitter3`, `rfdc`, `cli-truncate`, and `wrap-ansi` as transitive
  deps for a layout we would need to override anyway.

**Verdict: do not use.** The opinionated UI fights §11.4 rather than serving it.

**`ink` (v7.0.1, 533 KB)**

Ink is a React-based terminal renderer. Every widget is a React component, layout is
Yoga (flexbox), and rendering happens in a virtual DOM. The result is powerful but the
payload is enormous: 25 production dependencies including `react-reconciler`,
`yoga-layout`, `scheduler`, and React itself.

For a three-zone, fixed-height display with at most 10–15 rows, this is architectural
overkill. The React component model is also a conceptual mismatch with the
event-driven step state machine in `@relay/core` — wiring up subscriptions from the
Runner into React component state is non-trivial and would pull React lifecycle
semantics into the CLI display path.

**Verdict: do not use.** Too heavy, wrong abstraction, wrong dependency profile.

**`log-update` (v7.2.0, 16.6 KB; v8.0.0, 18 KB)**

`log-update` rewrites the last N lines of terminal output in place. It exposes one
function: `logUpdate(text)`, which clears the previously-written block and prints the
new text. That is exactly the primitive needed to redraw the three-zone display.

- v7.2.0: Node ≥ 20, ESM, 5 transitive deps (all small, well-known).
- v8.0.0: Node ≥ 22, ESM, 6 transitive deps.

The tech spec mandates Node ≥ 20.10. `v7.2.0` matches that constraint exactly and is
the appropriate version to pin. (The `packages/cli/package.json` currently declares
`engines.node >= 25.8` — that appears to be the developer's local Node version
accidentally committed, not the intended minimum; the correct floor from the tech spec
is `>=20.10`.)

**`log-update` does carry dependencies** (`ansi-escapes`, `cli-cursor`, `slice-ansi`,
`strip-ansi`, `wrap-ansi`) that handle cursor hiding, ANSI-safe string slicing, and
line wrapping — all of which the raw-ANSI approach would need to re-implement manually.

**Raw ANSI cursor sequences (no library)**

The alternative is to write the rewrite primitive directly:

```
process.stdout.write('\x1B[<N>A\x1B[0J' + newContent)
```

This works, but requires reimplementing cursor save/restore, TTY detection guard
(crash if not a TTY), and ANSI-safe line-length calculation. `log-update` wraps all
of this. The ANSI approach is ~15–30 lines of boilerplate that is already debugged and
maintained inside `log-update`.

**Recommendation:** `log-update` v7.2.0 (Node ≥ 20 compatible). Use it as the single
redraw primitive beneath a hand-written renderer. The renderer assembles the three
zones as a plain string — header line + step lines + footer lines — and calls
`logUpdate(frame)` on every tick. This gives the layout control required by §11.2/11.3
while delegating the fiddly terminal mechanics to a well-tested library.

The non-TTY fallback bypasses `log-update` entirely and writes one JSON log line per
event to `process.stdout`.

---

## 4. `chokidar` vs `fs.watch`

### What the watcher is for (task_48 context)

The live state file watcher monitors `.relay/runs/<id>/state.json` for changes
written by the Runner. The CLI display subscribes to those changes to trigger a
redraw. This is a single-file watch on a path the CLI itself created — a focused use
case.

### `fs.watch` limitations on macOS and Linux

`fs.watch` has well-documented platform inconsistencies:

- **macOS**: the kernel event may report the directory name rather than the file name.
  Symlinks are not followed.
- **Linux**: inotify events for atomic writes (write-to-temp then rename) fire on the
  temp file, not the target. The state.json file is written atomically (CLAUDE.md hard
  rule 5), so on Linux the `change` event may never fire on `state.json` itself.
- Both platforms: rapid successive writes may coalesce events or drop them.

For a production CLI that users will rely on for observability of long-running flows,
silent missed events are not acceptable.

### `chokidar` v5

Chokidar v5 (released November 2025) is ESM-only and requires Node ≥ 20. It has one
runtime dependency (`readdirp`). Its internal watcher for file changes uses
`fs.watch` under the hood but normalizes the events: filenames are always reported,
atomic rename events are coalesced into a single `change` event on the target, and
rapid writes are debounced via the `awaitWriteFinish` option.

Chokidar v5 no longer bundles optional native bindings (the `fsevents` optional
dependency was removed in v4). On macOS, Node.js 20+ uses `kqueue`/FSEvents natively
through `fs.watch`, and chokidar v5 layers normalization on top of that.

The unpacked size is 82 KB (including `readdirp`). That is a reasonable cost for the
reliability guarantee.

**Recommendation:** `chokidar` v5. The atomic-write normalization alone justifies the
dependency — CLAUDE.md mandates atomic writes for state.json, and `fs.watch` has
known failure modes for exactly that pattern on Linux. Chokidar eliminates an entire
class of "live display missed an update" bug reports.

---

## 5. `env-paths`

### The problem

The CLI needs to resolve cross-platform paths for application data — specifically
`~/.relay` or the appropriate OS-native equivalent:

- macOS: `~/Library/Application Support/relay/`
- Linux: `~/.local/share/relay/` (XDG Base Directory)
- Windows: `%APPDATA%\relay\`

Hard-coding `path.join(os.homedir(), '.relay')` works on macOS and Linux but does not
follow Windows conventions. Windows users who expect XDG-style or `APPDATA`-style
layout will find files in an unexpected location.

### `env-paths` v4

`env-paths` v4 (2 KB source, 9.6 KB unpacked) returns an object with `data`, `config`,
`cache`, `log`, and `temp` paths, all resolved to the platform-appropriate directories.
It is ESM-only, requires Node ≥ 20, and has one transitive dependency (`is-safe-filename`).
Usage is three lines:

```typescript
import envPaths from 'env-paths';
const paths = envPaths('relay');
// paths.data  → platform-appropriate data directory
// paths.config → platform-appropriate config directory
```

### Verdict

The package is small, zero-friction, and eliminates a class of Windows compatibility
bugs before they are filed. Even if v1 only targets macOS and Linux, using `env-paths`
from the start means Windows support never requires a path-resolution refactor.

**Recommendation:** add `env-paths` v4.

---

## Decisions

| Category | Decision | Rationale |
|---|---|---|
| **commander** | Keep `commander`, upgrade pin to `14.0.3` | Richer subcommand API, universal contributor familiarity; `cac` is smaller but too thin for Relay's command depth |
| **color library** | `chalk` v5 | Chainable API handles `dim.bold()` combinations cleanly; full §4.3 color set covered; `NO_COLOR` + non-TTY guards wired manually in task_77 visual-identity module |
| **TTY progress strategy** | `log-update` v7.2.0 + hand-written three-zone renderer | `log-update` provides the in-place redraw primitive; the renderer owns layout, matching §11.2/11.3 exactly; `listr2` and `ink` both impose layouts that conflict with §11.4 |
| **live-state file watcher** | `chokidar` v5 | Normalizes atomic-write rename events on Linux (mandatory given CLAUDE.md rule 5); eliminates macOS filename-reporting inconsistencies in `fs.watch` |
| **cross-platform path resolution** | `env-paths` v4 | Three lines to get XDG/AppData-correct paths; prevents a Windows refactor later; cost is negligible |
