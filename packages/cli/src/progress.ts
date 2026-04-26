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
import type { Flow, StepStatus } from '@ganderbite/relay-core';
import { z } from '@ganderbite/relay-core';
import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';
import type { FSWatcher } from 'chokidar';
import { watch } from 'chokidar';
import logUpdate from 'log-update';
import { flowHeader, SYMBOLS } from './brand.js';
import { gray, green, red, yellow } from './color.js';
import { fmtCostApprox, fmtK } from './format.js';
import { DURATION_WIDTH, MODEL_WIDTH, STEP_NAME_WIDTH } from './layout.js';

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
// ProgressDisplay
// ---------------------------------------------------------------------------

/**
 * Three-zone live progress display.
 *
 * Constructor: `new ProgressDisplay(runDir, flow, auth)`
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

  #runId = '';
  #runStartedAt = '';
  #watcher: FSWatcher | null = null;
  #spinnerFrame = 0;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #isTTY: boolean;
  readonly #sigintHandlers: Array<() => void> = [];
  readonly #steps: Map<string, StepDisplayState> = new Map();
  #cumulativeTokens: number = 0;

  constructor(runDir: string, flow: Flow<TInput>, auth: AuthInfo) {
    this.#runDir = runDir;
    this.#flow = flow;
    this.#auth = auth;
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
      return ` ${sym} ${nameCol} ${model} ${progressCol} ${tokensCol}`;
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

    if (status === 'succeeded') {
      return ` ${green(SYMBOLS.ok)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${green(costStr)}`;
    }
    // failed or skipped
    return ` ${red(SYMBOLS.fail)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${red(costStr)}`;
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
