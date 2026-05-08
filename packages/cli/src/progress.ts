/**
 * TTY progress display for the Relay CLI.
 *
 * Renders the three-zone layout (header / step grid / footer) per the
 * live display spec. In-place redraw is handled by log-update v7; live-state
 * file watching by chokidar v5.
 *
 * When stdout is not a TTY the display falls back to one structured line per
 * state transition written to process.stderr.
 *
 * Events tailing uses a byte-offset approach: on each chokidar add/change event
 * only the newly-appended bytes are read from the events file, framed into
 * complete NDJSON lines, and validated with EventRecordSchema.safeParse. The
 * per-step offset and partial-line buffer are maintained in #tailState.
 *
 * The events watcher runs in both TTY and non-TTY modes when verbose=true.
 * In non-TTY+verbose mode each new EventRecord is emitted to stderr immediately
 * as { ts, step, event } JSON, decoupling output from the live-state transition.
 *
 * stop() awaits the in-flight tail promise for each step before closing the
 * events watcher, ensuring the final flush from EventLogWriter is captured.
 */

import type { FileHandle } from 'node:fs/promises';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventRecord, Flow, StepStatus } from '@ganderbite/relay-core';
import { EventRecordSchema, z } from '@ganderbite/relay-core';
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
  /**
   * Rendered lines (excluding text.delta streaming line).
   * The streaming line is inserted at streamingLineIndex when text deltas exist.
   */
  lines: string[];
  /**
   * Index in lines[] where the streaming line should be inserted.
   * Tracks the position of the most recent text.delta block so the streaming
   * line appears at the correct conversational position rather than always at
   * the bottom.
   */
  streamingLineIndex: number;
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
}

function makeAccumulator(): VerboseAccumulator {
  return {
    lines: [],
    streamingLineIndex: 0,
    textDeltaChars: 0,
    turns: 0,
    tools: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-step tail state — byte-offset tailing
// ---------------------------------------------------------------------------

interface TailState {
  /** Byte offset of the next unread byte in the events file. */
  offset: number;
  /** Accumulated partial line (bytes read but no trailing newline yet). */
  partial: string;
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
  /** Debounce timer for live-state file changes (separate from events debounce). */
  #liveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce timer for events file changes (separate from live-state debounce). */
  #eventsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #isTTY: boolean;
  readonly #sigintHandlers: Array<() => void> = [];
  readonly #steps: Map<string, StepDisplayState> = new Map();
  #cumulativeTokens: number = 0;

  /**
   * stepId -> verbose accumulator. Lazy-allocated: only created when
   * verbose=true and the first events file change fires for the step.
   */
  #verboseAccumulators: Map<string, VerboseAccumulator> | null = null;

  /**
   * stepId -> tail state for byte-offset reading of events files.
   * Lazy-allocated alongside #verboseAccumulators.
   */
  #tailStates: Map<string, TailState> | null = null;

  /**
   * Tracks the most recent in-flight tail promise per step so stop() can
   * await it before closing the watcher.
   */
  readonly #inFlightTail: Map<string, Promise<void>> = new Map();

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

    // Start the events watcher in both TTY and non-TTY modes when verbose=true.
    // In TTY mode this supplements the spinner; in non-TTY mode it is the sole
    // path for emitting NDJSON EventRecords to stderr.
    if (this.#verbose) {
      this.#verboseAccumulators = new Map();
      this.#tailStates = new Map();
      this.#startEventsWatcher();
    }
  }

  /**
   * Stop the display.
   * Clears the live area (TTY), unwires SIGINT handlers, and closes the watcher.
   * Awaits all in-flight tail reads before closing the events watcher so the
   * final EventLogWriter.flush() bytes are captured.
   */
  stop(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#liveDebounceTimer !== null) {
      clearTimeout(this.#liveDebounceTimer);
      this.#liveDebounceTimer = null;
    }
    if (this.#eventsDebounceTimer !== null) {
      clearTimeout(this.#eventsDebounceTimer);
      this.#eventsDebounceTimer = null;
    }
    if (this.#watcher !== null) {
      void this.#watcher.close();
      this.#watcher = null;
    }

    // Drain all in-flight tail reads before closing the events watcher.
    // This ensures that the final EventLogWriter.flush() bytes are tailed
    // before the watcher closes. awaitWriteFinish on the watcher fires one
    // final change event after flush; we await the resulting tail promise here.
    const drainAndClose = async (): Promise<void> => {
      const pending = Array.from(this.#inFlightTail.values());
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      if (this.#eventsWatcher !== null) {
        await this.#eventsWatcher.close();
        this.#eventsWatcher = null;
      }
    };
    void drainAndClose();

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

    // Spinner tick: advance frame every 100 ms and repaint.
    this.#tickTimer = setInterval(() => {
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SYMBOLS.spinner.length;
      this.#redraw();
    }, 100);

    this.#redraw();
  }

  /**
   * Start the events directory watcher. Runs in both TTY and non-TTY modes
   * when verbose=true. Each add/change event triggers a byte-offset tail read.
   */
  #startEventsWatcher(): void {
    const eventsDir = join(this.#runDir, 'events');
    this.#eventsWatcher = watch(eventsDir, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });
    this.#eventsWatcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      void this.#tailEventsFile(filePath);
    });
    this.#eventsWatcher.on('change', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      void this.#tailEventsFile(filePath);
    });
  }

  #stepIdFromEventsPath(filePath: string): string {
    const basename = filePath.split('/').at(-1) ?? filePath.split('\\').at(-1) ?? '';
    return basename.replace(/\.jsonl$/, '');
  }

  /**
   * Tail-read the events file from the stored byte offset, parse complete NDJSON
   * lines, validate with EventRecordSchema.safeParse, and update the accumulator.
   *
   * In non-TTY+verbose mode, each newly-parsed EventRecord is emitted to stderr
   * as { ts, step, event } JSON immediately — decoupled from the live-state
   * running→done transition.
   *
   * In TTY mode, the accumulator is updated and a debounced redraw is scheduled.
   */
  async #tailEventsFile(filePath: string): Promise<void> {
    const stepId = this.#stepIdFromEventsPath(filePath);
    if (!this.#steps.has(stepId)) return;

    // Guard: verbose must be true and maps must be allocated.
    const accs = this.#verboseAccumulators;
    const tails = this.#tailStates;
    if (accs === null || tails === null) return;

    // Chain this tail onto the previous in-flight promise for this step so
    // concurrent watcher events serialize correctly.
    const previous = this.#inFlightTail.get(stepId) ?? Promise.resolve();
    const next = previous.then(() => this.#doTailEventsFile(filePath, stepId, accs, tails));
    this.#inFlightTail.set(stepId, next);
    // Swallow the error so the chain never rejects and stop() can await it.
    await next.catch(() => undefined);
  }

  async #doTailEventsFile(
    filePath: string,
    stepId: string,
    accs: Map<string, VerboseAccumulator>,
    tails: Map<string, TailState>,
  ): Promise<void> {
    // Lazy-allocate tail state and accumulator for this step.
    let tail = tails.get(stepId);
    if (tail === undefined) {
      tail = { offset: 0, partial: '' };
      tails.set(stepId, tail);
    }
    let acc = accs.get(stepId);
    if (acc === undefined) {
      acc = makeAccumulator();
      accs.set(stepId, acc);
    }

    // Open the file and read from the current offset to EOF.
    let handle: FileHandle | null = null;
    try {
      handle = await open(filePath, 'r');
    } catch {
      // File not yet available — skip; next change event will retry.
      return;
    }

    let chunk: Buffer;
    try {
      const stat = await handle.stat();
      const fileSize = stat.size;
      if (fileSize <= tail.offset) {
        // No new bytes — nothing to do.
        return;
      }
      const toRead = fileSize - tail.offset;
      chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(chunk, 0, toRead, tail.offset);
      tail.offset += bytesRead;
      chunk = chunk.subarray(0, bytesRead);
    } catch {
      return;
    } finally {
      try {
        await handle?.close();
      } catch {
        // best-effort close
      }
    }

    // Frame the chunk into complete lines, preserving the partial buffer.
    const text = tail.partial + chunk.toString('utf8');
    const newlineIndex = text.lastIndexOf('\n');
    if (newlineIndex === -1) {
      // No complete line yet — accumulate into partial buffer.
      tail.partial = text;
      return;
    }

    // Everything up to and including the last newline is complete lines.
    tail.partial = text.slice(newlineIndex + 1);
    const completeText = text.slice(0, newlineIndex);
    const newRecords: EventRecord[] = [];

    for (const line of completeText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Malformed JSON — skip.
        continue;
      }

      const result = EventRecordSchema.safeParse(parsed);
      if (!result.success) {
        // Malformed record — skip without throwing.
        continue;
      }

      const record = result.data as EventRecord;
      newRecords.push(record);
      this.#applyEventToAccumulator(acc, record);
    }

    // In non-TTY+verbose mode, emit each new EventRecord to stderr immediately.
    // This decouples NDJSON output from the live-state running→done transition.
    if (!this.#isTTY && newRecords.length > 0) {
      for (const record of newRecords) {
        process.stderr.write(
          `${JSON.stringify({ ts: record.ts, step: stepId, event: record.event })}\n`,
        );
      }
    }

    // In TTY mode, schedule a debounced redraw.
    if (this.#isTTY && newRecords.length > 0) {
      if (this.#eventsDebounceTimer !== null) clearTimeout(this.#eventsDebounceTimer);
      this.#eventsDebounceTimer = setTimeout(() => {
        this.#eventsDebounceTimer = null;
        this.#redraw();
      }, 100);
    }
  }

  /**
   * Apply a single EventRecord to the accumulator, updating counters and the
   * rendered lines array.
   *
   * The streaming line is inserted at streamingLineIndex — the position of the
   * most recent text.delta block in the rendered sub-stream. When text.delta
   * events arrive, streamingLineIndex is updated to the current end of lines[]
   * so the streaming line appears at the correct conversational position (option
   * (a) from FLAG-3: track text.delta position rather than always appending at
   * the bottom).
   */
  #applyEventToAccumulator(acc: VerboseAccumulator, record: EventRecord): void {
    const ev = record.event;

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
      // Update streamingLineIndex to track where this text.delta block sits
      // in the rendered stream. The streaming line will be inserted here so
      // it appears at the correct position relative to surrounding tool calls.
      acc.streamingLineIndex = acc.lines.length;
      return; // text.delta has no rendered line of its own
    }

    // Render the event to a line (returns null for turn.end, text.delta).
    const rendered = renderVerboseEvent(record);
    if (rendered !== null) {
      acc.lines.push(rendered);
    }
  }

  /**
   * Build the display lines for the accumulator, inserting the streaming line
   * at the tracked position when text deltas have been observed.
   */
  #buildAccumulatorLines(acc: VerboseAccumulator): string[] {
    if (acc.textDeltaChars === 0) {
      return acc.lines;
    }
    const streamingLine = renderStreamingLine(acc.textDeltaChars);
    const result = acc.lines.slice(0, acc.streamingLineIndex);
    result.push(streamingLine);
    result.push(...acc.lines.slice(acc.streamingLineIndex));
    return result;
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
      // In non-TTY mode, emit step.start prose only when verbose is false.
      // When verbose=true, stderr is NDJSON-only and prose lines would break
      // pipe-friendly consumers (FLAG-6).
      if (!this.#isTTY && !this.#verbose) {
        logStructured('step.start', { runnerId, model: parsed.model });
      }
    }

    if (wasRunning && nowDone) {
      const started = state.runningStartedAt ?? parsed.startedAt;
      state.finalDurationMs = Date.now() - new Date(started).getTime();

      // In non-TTY mode, emit step.end prose only when verbose is false.
      // When verbose=true, events are emitted NDJSON-only via the watcher path
      // in #doTailEventsFile — no prose step.end line needed (FLAG-6).
      if (!this.#isTTY && !this.#verbose) {
        logStructured('step.end', { runnerId, durMs: state.finalDurationMs });
      }

      // Replace sub-stream lines with the step summary when verbose and TTY.
      if (this.#verbose && this.#isTTY) {
        const acc = this.#verboseAccumulators?.get(runnerId);
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
        freshAcc.streamingLineIndex = 0;
        freshAcc.textDeltaChars = 0;
        this.#verboseAccumulators?.set(runnerId, freshAcc);
      }
    }

    state.live = parsed;

    // Debounce live-state redraws independently from events debounce (FLAG-1).
    if (this.#liveDebounceTimer !== null) clearTimeout(this.#liveDebounceTimer);
    this.#liveDebounceTimer = setTimeout(() => {
      this.#liveDebounceTimer = null;
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

      // When verbose, append accumulated sub-stream lines below the running step row.
      if (this.#verbose) {
        const acc = this.#verboseAccumulators?.get(state.id);
        if (acc !== undefined) {
          const subLines = this.#buildAccumulatorLines(acc);
          if (subLines.length > 0) {
            return [stepRowLine, ...subLines].join('\n');
          }
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
    // The summary line replaces the live sub-stream on step completion per the
    // renderStepSummary contract. This is intentional even though the task spec
    // only mentioned running rows — keeping the summary visible after completion
    // is the correct behavior (FLAG-5).
    if (this.#verbose) {
      const acc = this.#verboseAccumulators?.get(state.id);
      if (acc !== undefined) {
        const subLines = this.#buildAccumulatorLines(acc);
        if (subLines.length > 0) {
          return [terminalRow, ...subLines].join('\n');
        }
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
