# Visual Grammar — Symbols, Colors, Layout

The single source of truth for visual constants is `packages/cli/src/visual.ts` (built in sprint 6 task_77). This document mirrors the values so you can write code that imports them correctly.

## Constants (mirror of visual.ts)

```ts
export const MARK = '●─▶●─▶●─▶●';
export const WORDMARK = '●─▶●─▶●─▶●  relay';

export const SYMBOLS = {
  ok: '✓',
  fail: '✕',
  warn: '⚠',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  pending: '○',
  dot: '·',
  arrow: '▶',
  cancelled: '⊘',
} as const;
```

Never define these inline. Always `import { MARK, SYMBOLS, green, yellow, red, gray, bold } from '../visual.js'`.

## Color palette (chalk wrappers)

Each color helper passes the string through chalk when colors are enabled, and returns the raw string when disabled.

```ts
green(s: string): string   // ✓ rows, success summaries, subscription billing
yellow(s: string): string  // ⠋ rows, ⚠ warnings, API-billing mode banners
red(s: string): string     // ✕ rows, failure summaries, blocking doctor checks
gray(s: string): string    // ○ rows, pending labels, metadata, secondary text
bold(s: string): string    // headings, the mark when paired with a verb
```

Color is **disabled** when ANY of these is true:

1. `process.env.NO_COLOR` is set to a non-empty value (no-color.org spec).
2. `--no-color` is passed on the command line.
3. `process.stdout.isTTY` is false (CI, redirected, piped).
4. `~/.relay/config.json` has `color: "never"`.

Precedence: explicit `--no-color` > `NO_COLOR` env > config file > auto-TTY detection.

## Spinner animation

10 frames at ~80ms per frame (Braille spinner). The `ProgressDisplay` class advances the frame in a rAF-style loop, redrawing the affected rows only.

## Layout templates

### Banner header
```
●─▶●─▶●─▶●  <verb or race name>[  ·  <runId>][  <status symbol>]
```
Two spaces between mark and the next token. ` · ` separator with a space on each side.

### KV-row (label column = 8 chars, then content)
```
<label padded to 8>  <value>
```
Examples:
```
race     codebase-discovery v0.1.0
bill     subscription (max)  ·  no api charges
est      $0.40  ·  5 runners  ·  ~12 min
```
Keep the label width consistent across rows in the same block. 8 chars handles "race", "input", "run", "bill", "est", "cost", "output". For `doctor` and `runs` the labels can be longer; pick the smallest width that fits all labels in the block.

### Runner row
```
<sym> <runnerName padded to 16> <model padded to 8>  <progress>  <tokensIn>K→<tokensOut>K    [~]$<cost>
```
- `sym`: 1 char (`✓ ✕ ⠋ ○ ⊘`) followed by 1 space.
- Runner name: padded to 16 chars (use the longest in the race, with a 16 floor).
- Model: padded to 8 chars (`sonnet`, `haiku`, `opus`).
- Progress: `X.Ys` for completed, `turn N` for in-flight, `waiting on X, Y` for pending.
- Token counts: `<thousands>K→<thousands>K` (omit when not yet known).
- Cost: `$0.005`, prefixed with `~` when in-flight (estimate).

### `next:` block
```
next:
    <verb>            <command>
    <verb>            <command>
```
4-space indent under `next:`. Verb column padded for alignment. Verbs lowercase imperative ("open the report", "run again fresh").

### Footer line (live progress)
```
 est  $<est>    spent  $<spent>    elapsed  <HH:MM>    ctrl-c saves state
```
4-space gaps between sections. The "ctrl-c saves state" reminder is always last.

## Horizontal rules

```
───────────────────────────────────────────────────────
```
Box-drawing horizontal line, 56 chars wide (or terminal width if smaller). Used to close the pre-run banner — separates banner from progress.

## Live progress display zones (product spec §11.2)

```
┌────────────────────────────────────────┐
│ HEADER (1 line, static)                │
├────────────────────────────────────────┤
│ STEP GRID (N lines, dynamic)           │
├────────────────────────────────────────┤
│ FOOTER (2 lines, semi-dynamic)         │
└────────────────────────────────────────┘
```

ANSI cursor sequences:
- `\x1b[<n>A` move cursor up N lines
- `\x1b[2K` clear current line
- `\x1b[?25l` hide cursor (call on display.start)
- `\x1b[?25h` show cursor (call on display.stop)

Always restore cursor visibility in a `finally` block — a crashed display that leaves the terminal cursor hidden is a bad citizen.

## Non-TTY fallback

When `process.stdout.isTTY` is false, do NOT render the live display. Emit one structured line per state transition:

```
2026-04-17T14:32:01Z info  runner.start   runnerId=inventory  model=sonnet
2026-04-17T14:32:03Z info  runner.end     runnerId=inventory  durMs=2104  costUsd=0.005
```

Format: `<ISO-8601> <level> <event> <key=value pairs>`. One line per event. No color.
