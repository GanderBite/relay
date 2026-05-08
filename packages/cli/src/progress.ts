/**
 * TTY progress display for the Relay CLI.
 *
 * Renders the three-zone layout (header / step grid / footer) per the
 * live display spec. In-place redraw is handled by log-update v7; live-state
 * file watching by chokidar v5.
 *
 * When stdout is not a TTY the display falls back to one structured line per
 * state transition written to process.stderr.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventRecord, Flow, StepStatus } from '@ganderbite/relay-core';
import { z } from '@ganderbite/relay-core';
import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';
import type { FSWatcher } from 'chokidar';
import { watch } from 'chokidar';
import logUpdate from 'log-update';
import { flowHeader, SYMBOLS } from './brand.js';
import { gray, green, red, yellow } from './color.js';
import { fmtCostApprox, fmtK } from './format.js';
import { DURATION_WIDTH, MODEL_WIDTH, STEP_NAME_WIDTH } from './layout.js';
import { renderStepSummary, renderStreamingLine, renderVerboseEvent } from './verboseStream.js';

// ---------------------------------------------------------------------------
// Live state Zod schema — LiveStatePartial type is imported from @ganderbite/relay-core/live-state.
// ---------------------------------------------------------------------------

const LiveStatePartialSchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  attempt: z.number(),
  startedAt: z.string(),
  lastUpdateAt: z.string(),
  model: z.string().optional(),
  tokensSoFar: z.number().optional(),
  toolsSoFar: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Auth descriptor
// ---------------------------------------------------------------------------

export interface AuthInfo {
  /** Short label shown in banners, e.g. "subscription (max)" */
  label: string;
  /** Estimated cost ceiling in USD; 0 for subscription billing */
  estUsd: number;
}

function fmtElapsedSec(startedAt: string): string {
  const s = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function fmtHHMM(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Per-step display state
// ---------------------------------------------------------------------------

interface StepDisplayState {
  id: string;
  dependsOn: readonly string[];
  live: LiveStatePartial | null;
  /** ISO string captured when the step first entered 'running'. */
  runningStartedAt: string | null;
  /** Frozen after the step leaves 'running'. */
  finalDurationMs: number | null;
  finalTokensIn: number | null;
  finalTokensOut: number | null;
  finalCostUsd: number | null;
  finalModel: string | null;
  cumulativeTokens: number | null;
}

// ---------------------------------------------------------------------------
// Non-TTY structured log
// ---------------------------------------------------------------------------

function logStructured(event: string, fields: Record<string, string | number | undefined>): void {
  const iso = new Date().toISOString();
  const cols = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`${iso} info  ${event.padEnd(12)} ${cols.join('  ')}\n`);
}

// ---------------------------------------------------------------------------
// Per-step verbose accumulator
// ---------------------------------------------------------------------------

interface VerboseAccumulator {
  /** Rendered lines (excluding text.delta streaming line). */
  lines: string[];
  /** Accumulated char count from text.delta events. */
  textDeltaChars: number;
  /** Accumulated turn count (turn.start events). */
  turns: number;
  /** Accumulated tool call count (tool.call events). */
  tools: number;
  /** Latest tokensIn from a usage event. */
  tokensIn: number;
  /** Latest tokensOut from a usage event. */
  tokensOut: number;
  /** Latest costUsd from a stream.end event. */
  costUsd: number | undefined;
  /** All EventRecords parsed from the .jsonl file — kept for non-TTY NDJSON emit. */
  records: EventRecord[];
}

function makeAccumulator(): VerboseAccumulator {
  return {
    lines: [],
    textDeltaChars: 0,
    turns: 0,
    tools: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: undefined,
    records: [],
  };
}

// ---------------------------------------------------------------------------
// ProgressDisplay
// ---------------------------------------------------------------------------

/**
 * Three-zone live progress display.
 *
 * Constructor: `new ProgressDisplay(runDir, flow, auth, verbose?)`
 * Start:       `.start(runId)` — begins watching and rendering.
 * Stop:        `.stop()` — clears the live area and returns terminal control.
 * Metrics:     `.updateRunnerMetrics(runnerId, { tokensIn, tokensOut, costUsd, durationMs, model })`
 *              — called by the run command after each runner completes.
 * SIGINT:      `.onSigint(handler)` — register a ctrl-c handler; wired on
 *              start() and unwired on stop().
 */
export class ProgressDisplay<TInput = unknown> {
  readonly #runDir: string;
  readonly #flow: Flow<TInput>;
  readonly #auth: AuthInfo;
  readonly #verbose: boolean;

  #runId = '';
  #runStartedAt = '';
  #watcher: FSWatcher | null = null;
  #eventsWatcher: FSWatcher | null = null;
  #spinnerFrame = 0;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #isTTY: boolean;
  readonly #sigintHandlers: Array<() => void> = [];
  readonly #steps: Map<string, StepDisplayState> = new Map();
  #cumulativeTokens: number = 0;

  /** stepId -> verbose accumulator (populated only when verbose=true) */
  readonly #verboseAccumulators: Map<string, VerboseAccumulator> = new Map();

  constructor(runDir: string, flow: Flow<TInput>, auth: AuthInfo, verbose = false) {
    this.#runDir = runDir;
    this.#flow = flow;
    this.#auth = auth;
    this.#verbose = verbose;
    this.#isTTY = Boolean(process.stdout.isTTY);
  }

  /**
   * Register a ctrl-c handler.
   * The handler is wired to SIGINT when start() runs and unwired on stop().
   */
  onSigint(handler: () => void): void {
    this.#sigintHandlers.push(handler);
  }

  /**
   * Begin watching live state files and rendering the display.
   * Call once per instance.
   */
  start(runId: string): void {
    this.#runId = runId;
    this.#runStartedAt = new Date().toISOString();

    for (const runnerId of this.#flow.stepOrder) {
      const step = this.#flow.steps[runnerId];
      this.#steps.set(runnerId, {
        id: runnerId,
        dependsOn: step?.dependsOn ?? [],
        live: null,
        runningStartedAt: null,
        finalDurationMs: null,
        finalTokensIn: null,
        finalTokensOut: null,
        finalCostUsd: null,
        finalModel: null,
        cumulativeTokens: null,
      });
    }

    for (const handler of this.#sigintHandlers) {
      process.on('SIGINT', handler);
    }

    if (this.#isTTY) {
      this.#startTTY();
    } else {
      logStructured('run.start', { runId, flow: this.#flow.name });
    }
  }

  /**
   * Stop the display.
   * Clears the live area (TTY), unwires SIGINT handlers, and closes the watcher.
   */
  stop(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#watcher !== null) {
      void this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#eventsWatcher !== null) {
      void this.#eventsWatcher.close();
      this.#eventsWatcher = null;
    }
    if (this.#isTTY) {
      logUpdate.done();
    }
    for (const handler of this.#sigintHandlers) {
      process.off('SIGINT', handler);
    }
  }

  /**
   * Push final per-step metrics from the run command after each step completes.
   * The live state file carries only in-flight data; final token breakdown and
   * cost are available only from the CostTracker, which the caller reads.
   */
  updateRunnerMetrics(
    runnerId: string,
    metrics: {
      tokensIn: number;
      tokensOut: number;
      costUsd: number | undefined;
      durationMs: number;
      model: string;
    },
  ): void {
    const state = this.#steps.get(runnerId);
    if (state === undefined) return;
    state.finalTokensIn = metrics.tokensIn;
    state.finalTokensOut = metrics.tokensOut;
    state.finalCostUsd = metrics.costUsd ?? 0;
    state.finalDurationMs = metrics.durationMs;
    state.finalModel = metrics.model;
    this.#cumulativeTokens += metrics.tokensIn + metrics.tokensOut;
    state.cumulativeTokens = this.#cumulativeTokens;
    if (this.#isTTY) this.#redraw();
  }

  // -------------------------------------------------------------------------
  // TTY internals
  // -------------------------------------------------------------------------

  #startTTY(): void {
    const liveDir = join(this.#runDir, 'live');

    // Watch the directory itself, not a glob. On macOS the chokidar FSEvents
    // backend fires zero events for a `dir/*.json` glob pattern — the directory
    // watch is the only form that works reliably.
    this.#watcher = watch(liveDir, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });

    const onFileChange = (filePath: string): void => {
      if (!filePath.endsWith('.json')) return;
      void this.#loadLiveFile(filePath);
    };

    this.#watcher.on('add', onFileChange);
    this.#watcher.on('change', onFileChange);

    // When verbose, additionally watch the events directory for .jsonl files.
    if (this.#verbose) {
      const eventsDir = join(this.#runDir, 'events');
      this.#eventsWatcher = watch(eventsDir, {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
      });
      this.#eventsWatcher.on('add', this.#onEventsFileChange.bind(this));
      this.#eventsWatcher.on('change', this.#onEventsFileChange.bind(this));
    }

    // Spinner tick: advance frame every 100 ms and repaint.
    this.#tickTimer = setInterval(() => {
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SYMBOLS.spinner.length;
      this.#redraw();
    }, 100);

    this.#redraw();
  }

  #stepIdFromEventsPath(filePath: string): string {
    const basename = filePath.split('/').at(-1) ?? filePath.split('\\').at(-1) ?? '';
    return basename.replace(/\.jsonl$/, '');
  }

  #onEventsFileChange(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) return;
    void this.#readEventsFile(filePath);
  }

  async #readEventsFile(filePath: string): Promise<void> {
    const stepId = this.#stepIdFromEventsPath(filePath);
    if (!this.#steps.has(stepId)) return;

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      // File not yet available or read race — skip; next change event will retry.
      return;
    }

    const acc = this.#verboseAccumulators.get(stepId) ?? makeAccumulator();

    // Reset accumulated state and rebuild from scratch on every read.
    acc.lines = [];
    acc.textDeltaChars = 0;
    acc.turns = 0;
    acc.tools = 0;
    acc.tokensIn = 0;
    acc.tokensOut = 0;
    acc.costUsd = undefined;
    acc.records = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // Malformed line — skip and continue.
        continue;
      }

      // Validate the minimal shape we need before casting.
      if (
        record === null ||
        typeof record !== 'object' ||
        !('seq' in record) ||
        !('ts' in record) ||
        !('attempt' in record) ||
        !('event' in record)
      ) {
        continue;
      }

      const typed = record as EventRecord;
      acc.records.push(typed);

      const ev = typed.event;

      // Accumulate counters for step summary.
      if (ev.type === 'turn.start') {
        acc.turns += 1;
      } else if (ev.type === 'tool.call') {
        acc.tools += 1;
      } else if (ev.type === 'usage') {
        acc.tokensIn = ev.usage.inputTokens ?? 0;
        acc.tokensOut = ev.usage.outputTokens ?? 0;
      } else if (ev.type === 'stream.end') {
        if (ev.costUsd !== undefined) {
          acc.costUsd = ev.costUsd;
        }
      } else if (ev.type === 'text.delta') {
        acc.textDeltaChars += ev.delta.length;
      }

      // Render the event to a line (text.delta returns null — handled via streaming line).
      const rendered = renderVerboseEvent(typed);
      if (rendered !== null) {
        acc.lines.push(rendered);
      }
    }

    // Append the streaming line only when there have been text deltas.
    if (acc.textDeltaChars > 0) {
      acc.lines.push(renderStreamingLine(acc.textDeltaChars));
    }

    this.#verboseAccumulators.set(stepId, acc);

    // Debounce redraws triggered from events file changes.
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#isTTY) this.#redraw();
    }, 100);
  }

  async #loadLiveFile(filePath: string): Promise<void> {
    const basename = filePath.split('/').at(-1) ?? filePath.split('\\').at(-1) ?? '';
    const runnerId = basename.replace(/\.json$/, '');
    const state = this.#steps.get(runnerId);
    if (state === undefined) return;

    let parsed: LiveStatePartial;
    try {
      const raw = await readFile(filePath, 'utf8');
      const result = LiveStatePartialSchema.safeParse(JSON.parse(raw));
      if (!result.success) return;
      const d = result.data;
      parsed = {
        status: d.status,
        attempt: d.attempt,
        startedAt: d.startedAt,
        lastUpdateAt: d.lastUpdateAt,
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.tokensSoFar !== undefined ? { tokensSoFar: d.tokensSoFar } : {}),
        ...(d.toolsSoFar !== undefined ? { toolsSoFar: d.toolsSoFar } : {}),
      };
    } catch {
      // File read race or JSON parse failure — skip; next event will retry.
      return;
    }

    const wasRunning = state.live?.status === 'running';
    const nowDone =
      parsed.status === 'succeeded' || parsed.status === 'failed' || parsed.status === 'skipped';

    if (parsed.status === 'running' && state.runningStartedAt === null) {
      state.runningStartedAt = parsed.startedAt;
      if (!this.#isTTY) {
        logStructured('step.start', { runnerId, model: parsed.model });
      }
    }

    if (wasRunning && nowDone) {
      const started = state.runningStartedAt ?? parsed.startedAt;
      state.finalDurationMs = Date.now() - new Date(started).getTime();

      if (!this.#isTTY) {
        logStructured('step.end', { runnerId, durMs: state.finalDurationMs });

        // Non-TTY verbose: emit one NDJSON line per EventRecord to stderr.
        if (this.#verbose) {
          const acc = this.#verboseAccumulators.get(runnerId);
          if (acc !== undefined) {
            for (const record of acc.records) {
              process.stderr.write(
                `${JSON.stringify({ ts: record.ts, step: runnerId, event: record })}\n`,
              );
            }
          } else {
            // Accumulator not yet populated via watcher — read the file directly.
            const eventsPath = join(this.#runDir, 'events', `${runnerId}.jsonl`);
            try {
              const raw = await readFile(eventsPath, 'utf8');
              for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                let record: unknown;
                try {
                  record = JSON.parse(trimmed);
                } catch {
                  continue;
                }
                if (
                  record === null ||
                  typeof record !== 'object' ||
                  !('seq' in record) ||
                  !('ts' in record) ||
                  !('attempt' in record) ||
                  !('event' in record)
                ) {
                  continue;
                }
                const typed = record as EventRecord;
                process.stderr.write(
                  `${JSON.stringify({ ts: typed.ts, step: runnerId, event: typed })}\n`,
                );
              }
            } catch {
              // Events file absent — nothing to emit.
            }
          }
        }
      }

      // Replace sub-stream lines with the step summary when verbose and TTY.
      if (this.#verbose && this.#isTTY) {
        const acc = this.#verboseAccumulators.get(runnerId);
        const summaryArgs: Parameters<typeof renderStepSummary>[0] = {
          turns: acc?.turns ?? 0,
          tools: acc?.tools ?? 0,
          tokensIn: acc?.tokensIn ?? 0,
          tokensOut: acc?.tokensOut ?? 0,
          ...(acc?.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        };
        const summaryLine = renderStepSummary(summaryArgs);
        const freshAcc = acc ?? makeAccumulator();
        freshAcc.lines = [summaryLine];
        this.#verboseAccumulators.set(runnerId, freshAcc);
      }
    }

    state.live = parsed;

    // Debounce redraws: coalesce rapid events within 100 ms.
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#isTTY) this.#redraw();
    }, 100);
  }

  #redraw(): void {
    const lines: string[] = [];

    // Zone 1 — Header (static, never changes during the run)
    lines.push(flowHeader(this.#flow.name, this.#runId));
    lines.push('');

    // Zone 2 — Step grid (one row per step)
    for (const [, state] of this.#steps) {
      lines.push(this.#stepRow(state));
    }
    lines.push('');

    // Zone 3 — Footer (two lines: totals + blank)
    const estStr = fmtCostApprox(this.#auth.estUsd);
    const spentStr = fmtCostApprox(this.#computeSpent());
    const elapsed = this.#runStartedAt !== '' ? fmtHHMM(this.#runStartedAt) : '00:00';

    lines.push(
      `  est  ${estStr}    spent  ${spentStr}    elapsed  ${elapsed}    ${gray('ctrl-c saves state')}`,
    );
    lines.push('');

    logUpdate(lines.join('\n'));
  }

  #stepRow(state: StepDisplayState): string {
    const live = state.live;
    const status: StepStatus = live?.status ?? 'pending';

    // Status symbol
    let sym: string;
    switch (status) {
      case 'running': {
        const frame =
          SYMBOLS.spinner[this.#spinnerFrame % SYMBOLS.spinner.length] ?? SYMBOLS.spinner[0]!;
        sym = yellow(frame);
        break;
      }
      case 'succeeded':
        sym = green(SYMBOLS.ok);
        break;
      case 'failed':
        sym = red(SYMBOLS.fail);
        break;
      case 'skipped':
        sym = gray(SYMBOLS.ok);
        break;
      default:
        sym = gray(SYMBOLS.pending);
    }

    const nameCol = state.id.padEnd(STEP_NAME_WIDTH);

    // Pending — show "waiting on X, Y" when deps are unfinished, else "not started"
    if (status === 'pending' || live === null) {
      const unfinished = state.dependsOn.filter((depId) => {
        const dep = this.#steps.get(depId);
        return dep?.live?.status !== 'succeeded';
      });
      const detail =
        unfinished.length > 0 ? `waiting on ${unfinished.join(', ')}` : gray('not started');
      return ` ${sym} ${nameCol} ${detail}`;
    }

    // Running — show model, turn N or elapsed, live token count (no cost — not calculable in-flight)
    if (status === 'running') {
      const model = (live.model ?? '-').padEnd(MODEL_WIDTH);
      const tools = live.toolsSoFar ?? 0;
      const runStart = state.runningStartedAt ?? live.startedAt;
      const progress = tools > 0 ? `${tools} tools` : fmtElapsedSec(runStart);
      const progressCol = progress.padEnd(DURATION_WIDTH);
      const totalToks = this.#cumulativeTokens + (live.tokensSoFar ?? 0);
      const tokensCol = fmtK(totalToks).padEnd(13);
      const stepRowLine = ` ${sym} ${nameCol} ${model} ${progressCol} ${tokensCol}`;

      // When verbose, append accumulated sub-stream lines below the step row.
      if (this.#verbose) {
        const subLines = this.#verboseAccumulators.get(state.id)?.lines ?? [];
        if (subLines.length > 0) {
          return [stepRowLine, ...subLines].join('\n');
        }
      }

      return stepRowLine;
    }

    // Succeeded / failed / skipped — show frozen metrics
    const model = (live.model ?? state.finalModel ?? '-').padEnd(MODEL_WIDTH);
    const durationMs = state.finalDurationMs ?? 0;
    const durSec = durationMs / 1000;
    const durStr = (durSec < 10 ? `${durSec.toFixed(1)}s` : `${Math.round(durSec)}s`).padEnd(
      DURATION_WIDTH,
    );
    const tokIn = state.finalTokensIn ?? 0;
    const tokOut = state.finalTokensOut ?? 0;
    const tokensCol = fmtK(state.cumulativeTokens ?? tokIn + tokOut).padEnd(13);
    const costUsd = state.finalCostUsd ?? 0;
    const costStr = fmtCostApprox(costUsd);

    let terminalRow: string;
    if (status === 'succeeded') {
      terminalRow = ` ${green(SYMBOLS.ok)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${green(costStr)}`;
    } else {
      // failed or skipped
      terminalRow = ` ${red(SYMBOLS.fail)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${red(costStr)}`;
    }

    // When verbose, append the summary line below the terminal step row.
    if (this.#verbose) {
      const subLines = this.#verboseAccumulators.get(state.id)?.lines ?? [];
      if (subLines.length > 0) {
        return [terminalRow, ...subLines].join('\n');
      }
    }

    return terminalRow;
  }

  #computeSpent(): number {
    let total = 0;
    for (const [, state] of this.#steps) {
      total += state.finalCostUsd ?? 0;
    }
    return total;
  }
}

// The module-level onSigint export has been removed. SIGINT handlers must be
// registered via ProgressDisplay#onSigint, which ties their lifecycle to
// start()/stop() and prevents leaked listeners.
