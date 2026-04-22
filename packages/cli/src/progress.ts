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

import type { FSWatcher } from 'chokidar';
import { watch } from 'chokidar';
import logUpdate from 'log-update';

import type { Race } from '@relay/core';

import {
  gray,
  green,
  MARK,
  red,
  SYMBOLS,
  STEP_NAME_WIDTH,
  MODEL_WIDTH,
  DURATION_WIDTH,
  yellow,
  flowHeader,
} from './visual.js';

// ---------------------------------------------------------------------------
// Live state shape — mirrors LiveStatePartial from @relay/core/runner/live-state.
// Defined locally because that module is not in the core package's exports map.
// ---------------------------------------------------------------------------

type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

interface LiveStatePartial {
  status: StepStatus;
  attempt: number;
  startedAt: string;
  lastUpdateAt: string;
  model?: string;
  tokensSoFar?: number;
  turnsSoFar?: number;
}

// ---------------------------------------------------------------------------
// Auth descriptor
// ---------------------------------------------------------------------------

export interface AuthInfo {
  /** Short label shown in banners, e.g. "subscription (max)" */
  label: string;
  /** Estimated cost ceiling in USD; 0 for subscription billing */
  estUsd: number;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtK(n: number): string {
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
}

function fmtCostUsd(usd: number, inFlight: boolean): string {
  const s = `$${usd.toFixed(3)}`;
  return inFlight ? `~${s}` : s;
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
}

// ---------------------------------------------------------------------------
// Non-TTY structured log
// ---------------------------------------------------------------------------

function logStructured(
  event: string,
  fields: Record<string, string | number | undefined>,
): void {
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
 * Metrics:     `.updateStepMetrics(stepId, { tokensIn, tokensOut, costUsd, durationMs, model })`
 *              — called by the run command after each step completes.
 * SIGINT:      `.onSigint(handler)` — register a ctrl-c handler; wired on
 *              start() and unwired on stop().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ProgressDisplay<TInput = any> {
  readonly #runDir: string;
  readonly #flow: Race<TInput>;
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

  constructor(runDir: string, flow: Race<TInput>, auth: AuthInfo) {
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

    for (const stepId of this.#flow.runnerOrder) {
      const step = this.#flow.runners[stepId];
      this.#steps.set(stepId, {
        id: stepId,
        dependsOn: step?.dependsOn ?? [],
        live: null,
        runningStartedAt: null,
        finalDurationMs: null,
        finalTokensIn: null,
        finalTokensOut: null,
        finalCostUsd: null,
        finalModel: null,
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
  updateStepMetrics(
    stepId: string,
    metrics: {
      tokensIn: number;
      tokensOut: number;
      costUsd: number | undefined;
      durationMs: number;
      model: string;
    },
  ): void {
    const state = this.#steps.get(stepId);
    if (state === undefined) return;
    state.finalTokensIn = metrics.tokensIn;
    state.finalTokensOut = metrics.tokensOut;
    state.finalCostUsd = metrics.costUsd ?? 0;
    state.finalDurationMs = metrics.durationMs;
    state.finalModel = metrics.model;
    if (this.#isTTY) this.#redraw();
  }

  // -------------------------------------------------------------------------
  // TTY internals
  // -------------------------------------------------------------------------

  #startTTY(): void {
    const liveDir = join(this.#runDir, 'live');

    this.#watcher = watch(`${liveDir}/*.json`, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });

    const onFileChange = (filePath: string): void => {
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
    const basename = (filePath.split('/').at(-1) ?? filePath.split('\\').at(-1)) ?? '';
    const stepId = basename.replace(/\.json$/, '');
    const state = this.#steps.get(stepId);
    if (state === undefined) return;

    let parsed: LiveStatePartial;
    try {
      const raw = await readFile(filePath, 'utf8');
      parsed = JSON.parse(raw) as LiveStatePartial;
    } catch {
      // File read race or JSON parse failure — skip; next event will retry.
      return;
    }

    const wasRunning = state.live?.status === 'running';
    const nowDone =
      parsed.status === 'succeeded' ||
      parsed.status === 'failed' ||
      parsed.status === 'skipped';

    if (parsed.status === 'running' && state.runningStartedAt === null) {
      state.runningStartedAt = parsed.startedAt;
      if (!this.#isTTY) {
        logStructured('step.start', { stepId, model: parsed.model });
      }
    }

    if (wasRunning && nowDone) {
      const started = state.runningStartedAt ?? parsed.startedAt;
      state.finalDurationMs = Date.now() - new Date(started).getTime();
      if (!this.#isTTY) {
        logStructured('step.end', { stepId, durMs: state.finalDurationMs });
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
    const estStr = fmtCostUsd(this.#auth.estUsd, false);
    const spentStr = fmtCostUsd(this.#computeSpent(), false);
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
        const frame = SYMBOLS.spinner[this.#spinnerFrame % SYMBOLS.spinner.length] ?? SYMBOLS.spinner[0]!;
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
      const detail = unfinished.length > 0
        ? `waiting on ${unfinished.join(', ')}`
        : gray('not started');
      return ` ${sym} ${nameCol} ${detail}`;
    }

    // Running — show model, turn N or elapsed, live token count (no cost — not calculable in-flight)
    if (status === 'running') {
      const model = (live.model ?? '-').padEnd(MODEL_WIDTH);
      const turns = live.turnsSoFar ?? 0;
      const runStart = state.runningStartedAt ?? live.startedAt;
      const progress = turns > 0 ? `turn ${turns}` : fmtElapsedSec(runStart);
      const progressCol = progress.padEnd(DURATION_WIDTH);
      const totalToks = live.tokensSoFar ?? 0;
      const tokensCol = fmtK(totalToks).padEnd(13);
      return ` ${sym} ${nameCol} ${model} ${progressCol} ${tokensCol}`;
    }

    // Succeeded / failed / skipped — show frozen metrics
    const model = ((live.model ?? state.finalModel) ?? '-').padEnd(MODEL_WIDTH);
    const durationMs = state.finalDurationMs ?? 0;
    const durSec = durationMs / 1000;
    const durStr = (durSec < 10 ? `${durSec.toFixed(1)}s` : `${Math.round(durSec)}s`).padEnd(DURATION_WIDTH);
    const tokIn = state.finalTokensIn ?? 0;
    const tokOut = state.finalTokensOut ?? 0;
    const tokensCol = `${fmtK(tokIn)}→${fmtK(tokOut)}`.padEnd(13);
    const costUsd = state.finalCostUsd ?? 0;
    const costStr = fmtCostUsd(costUsd, false);

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
