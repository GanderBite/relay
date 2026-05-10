/**
 * TTY progress renderer for the Relay CLI.
 *
 * Renders the three-zone layout (header / step grid / footer) per the
 * live display spec. In-place redraw is handled by log-update v7.
 * Consumes WatchEvent values produced by startWatcher (progress/watch.ts).
 */

import type { Flow, ReplayedEventRecord, StepStatus } from '@ganderbite/relay-core';
import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';
import logUpdate from 'log-update';
import { flowHeader, SYMBOLS } from '../brand.js';
import { gray, green, red, yellow } from '../color.js';
import { fmtCostApprox, fmtK } from '../format.js';
import { DURATION_WIDTH, MODEL_WIDTH, STEP_NAME_WIDTH } from '../layout.js';
import { renderStepSummary, renderStreamingLine, renderVerboseEvent } from '../verboseStream.js';
import type { WatchEvent } from './watch.js';

export interface AuthInfo {
  /** Short label shown in banners, e.g. "subscription (max)" */
  label: string;
  /** Estimated cost ceiling in USD; 0 for subscription billing */
  estUsd: number;
}

export interface StepDisplayState {
  id: string;
  dependsOn: readonly string[];
  live: LiveStatePartial | null;
  runningStartedAt: string | null;
  finalDurationMs: number | null;
  finalTokensIn: number | null;
  finalTokensOut: number | null;
  finalCostUsd: number | null;
  finalModel: string | null;
  cumulativeTokens: number | null;
}

interface VerboseAccumulator {
  lines: string[];
  streamingLineIndex: number;
  textDeltaChars: number;
  turns: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
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

function logStructured(event: string, fields: Record<string, string | number | undefined>): void {
  const iso = new Date().toISOString();
  const cols = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`${iso} info  ${event.padEnd(12)} ${cols.join('  ')}\n`);
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

/**
 * Stateful renderer that accepts WatchEvent values and repaints the terminal.
 *
 * Call start(runId) first, then feed events via onEvent() and push final
 * metrics via updateRunnerMetrics(). Call stop() to clear the display.
 */
export class ProgressRenderer<TInput = unknown> {
  readonly #flow: Flow<TInput>;
  readonly #auth: AuthInfo;
  readonly #verbose: boolean;
  readonly #isTTY: boolean;

  #runId = '';
  #runStartedAt = '';
  #spinnerFrame = 0;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #liveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  #eventsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #steps: Map<string, StepDisplayState> = new Map();
  #cumulativeTokens = 0;
  #verboseAccumulators: Map<string, VerboseAccumulator> | null = null;

  constructor(flow: Flow<TInput>, auth: AuthInfo, verbose = false) {
    this.#flow = flow;
    this.#auth = auth;
    this.#verbose = verbose;
    this.#isTTY = Boolean(process.stdout.isTTY);
  }

  start(runId: string): void {
    this.#runId = runId;
    this.#runStartedAt = new Date().toISOString();
    for (const runnerId of this.#flow.graph.topoOrder) {
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
    if (this.#verbose) this.#verboseAccumulators = new Map();
    if (this.#isTTY) {
      this.#tickTimer = setInterval(() => {
        this.#spinnerFrame = (this.#spinnerFrame + 1) % SYMBOLS.spinner.length;
        this.#redraw();
      }, 100);
      this.#redraw();
    } else {
      logStructured('run.start', { runId, flow: this.#flow.name });
    }
  }

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
    if (this.#isTTY) logUpdate.done();
  }

  onEvent(event: WatchEvent): void {
    if (event.kind === 'state') {
      this.#onLiveState(event.stepId, event.state);
    } else if (event.kind === 'events') {
      this.#onEventsRecords(event.stepId, event.records);
    }
  }

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

  #onLiveState(stepId: string, parsed: LiveStatePartial): void {
    const state = this.#steps.get(stepId);
    if (state === undefined) return;

    const wasRunning = state.live?.status === 'running';
    const nowDone =
      parsed.status === 'succeeded' || parsed.status === 'failed' || parsed.status === 'skipped';

    if (parsed.status === 'running' && state.runningStartedAt === null) {
      state.runningStartedAt = parsed.startedAt;
      if (!this.#isTTY && !this.#verbose)
        logStructured('step.start', { runnerId: stepId, model: parsed.model });
    }

    if (wasRunning && nowDone) {
      const started = state.runningStartedAt ?? parsed.startedAt;
      state.finalDurationMs = Date.now() - new Date(started).getTime();
      if (!this.#isTTY && !this.#verbose)
        logStructured('step.end', { runnerId: stepId, durMs: state.finalDurationMs });

      if (this.#verbose && this.#isTTY) {
        const acc = this.#verboseAccumulators?.get(stepId);
        const summaryLine = renderStepSummary({
          turns: acc?.turns ?? 0,
          tools: acc?.tools ?? 0,
          tokensIn: acc?.tokensIn ?? 0,
          tokensOut: acc?.tokensOut ?? 0,
          ...(acc?.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        });
        const freshAcc = acc ?? makeAccumulator();
        freshAcc.lines = [summaryLine];
        freshAcc.streamingLineIndex = 0;
        freshAcc.textDeltaChars = 0;
        this.#verboseAccumulators?.set(stepId, freshAcc);
      }
    }

    state.live = parsed;

    if (this.#liveDebounceTimer !== null) clearTimeout(this.#liveDebounceTimer);
    this.#liveDebounceTimer = setTimeout(() => {
      this.#liveDebounceTimer = null;
      if (this.#isTTY) this.#redraw();
    }, 100);
  }

  #onEventsRecords(stepId: string, records: ReplayedEventRecord[]): void {
    const accs = this.#verboseAccumulators;
    if (accs === null) return;
    if (!accs.has(stepId)) accs.set(stepId, makeAccumulator());
    const acc = accs.get(stepId)!;
    for (const record of records) this.#applyEventToAccumulator(acc, record);
    if (!this.#isTTY) {
      for (const record of records) {
        process.stderr.write(
          `${JSON.stringify({ ts: record.ts, step: stepId, event: record.event })}\n`,
        );
      }
    }
    if (this.#isTTY) {
      if (this.#eventsDebounceTimer !== null) clearTimeout(this.#eventsDebounceTimer);
      this.#eventsDebounceTimer = setTimeout(() => {
        this.#eventsDebounceTimer = null;
        this.#redraw();
      }, 100);
    }
  }

  #applyEventToAccumulator(acc: VerboseAccumulator, record: ReplayedEventRecord): void {
    const ev = record.event;
    if (ev.type === 'turn.start') {
      acc.turns += 1;
    } else if (ev.type === 'tool.call') {
      acc.tools += 1;
    } else if (ev.type === 'usage') {
      acc.tokensIn = ev.usage.inputTokens ?? 0;
      acc.tokensOut = ev.usage.outputTokens ?? 0;
    } else if (ev.type === 'stream.end') {
      if (ev.costUsd !== undefined) acc.costUsd = ev.costUsd;
    } else if (ev.type === 'text.delta') {
      acc.textDeltaChars += ev.delta.length;
      acc.streamingLineIndex = acc.lines.length;
      return;
    }
    const rendered = renderVerboseEvent(record);
    if (rendered !== null) acc.lines.push(rendered);
  }

  #buildAccumulatorLines(acc: VerboseAccumulator): string[] {
    if (acc.textDeltaChars === 0) return acc.lines;
    const streamingLine = renderStreamingLine(acc.textDeltaChars);
    const result = acc.lines.slice(0, acc.streamingLineIndex);
    result.push(streamingLine);
    result.push(...acc.lines.slice(acc.streamingLineIndex));
    return result;
  }

  #redraw(): void {
    const lines: string[] = [];
    lines.push(flowHeader(this.#flow.name, this.#runId));
    lines.push('');
    for (const [, state] of this.#steps) lines.push(this.#stepRow(state));
    lines.push('');
    const elapsed = this.#runStartedAt !== '' ? fmtHHMM(this.#runStartedAt) : '00:00';
    lines.push(
      `  est  ${fmtCostApprox(this.#auth.estUsd)}    spent  ${fmtCostApprox(this.#computeSpent())}    elapsed  ${elapsed}    ${gray('ctrl-c saves state')}`,
    );
    lines.push('');
    logUpdate(lines.join('\n'));
  }

  #stepRow(state: StepDisplayState): string {
    const live = state.live;
    const status: StepStatus = live?.status ?? 'pending';

    let sym: string;
    switch (status) {
      case 'running':
        sym = yellow(
          SYMBOLS.spinner[this.#spinnerFrame % SYMBOLS.spinner.length] ?? SYMBOLS.spinner[0]!,
        );
        break;
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

    if (status === 'pending' || live === null) {
      const unfinished = state.dependsOn.filter(
        (depId) => this.#steps.get(depId)?.live?.status !== 'succeeded',
      );
      const detail =
        unfinished.length > 0 ? `waiting on ${unfinished.join(', ')}` : gray('not started');
      return ` ${sym} ${nameCol} ${detail}`;
    }

    if (status === 'running') {
      const model = (live.model ?? '-').padEnd(MODEL_WIDTH);
      const tools = live.toolsSoFar ?? 0;
      const runStart = state.runningStartedAt ?? live.startedAt;
      const progressCol = (tools > 0 ? `${tools} tools` : fmtElapsedSec(runStart)).padEnd(
        DURATION_WIDTH,
      );
      const tokensCol = fmtK(this.#cumulativeTokens + (live.tokensSoFar ?? 0)).padEnd(13);
      const stepRowLine = ` ${sym} ${nameCol} ${model} ${progressCol} ${tokensCol}`;
      if (this.#verbose) {
        const acc = this.#verboseAccumulators?.get(state.id);
        if (acc !== undefined) {
          const subLines = this.#buildAccumulatorLines(acc);
          if (subLines.length > 0) return [stepRowLine, ...subLines].join('\n');
        }
      }
      return stepRowLine;
    }

    // Succeeded / failed / skipped — show frozen metrics
    const model = (live.model ?? state.finalModel ?? '-').padEnd(MODEL_WIDTH);
    const durSec = (state.finalDurationMs ?? 0) / 1000;
    const durStr = (durSec < 10 ? `${durSec.toFixed(1)}s` : `${Math.round(durSec)}s`).padEnd(
      DURATION_WIDTH,
    );
    const tokensCol = fmtK(
      state.cumulativeTokens ?? (state.finalTokensIn ?? 0) + (state.finalTokensOut ?? 0),
    ).padEnd(13);
    const costStr = fmtCostApprox(state.finalCostUsd ?? 0);
    const terminalRow =
      status === 'succeeded'
        ? ` ${green(SYMBOLS.ok)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${green(costStr)}`
        : ` ${red(SYMBOLS.fail)} ${nameCol} ${model} ${durStr} ${tokensCol}    ${red(costStr)}`;

    if (this.#verbose) {
      const acc = this.#verboseAccumulators?.get(state.id);
      if (acc !== undefined) {
        const subLines = this.#buildAccumulatorLines(acc);
        if (subLines.length > 0) return [terminalRow, ...subLines].join('\n');
      }
    }
    return terminalRow;
  }

  #computeSpent(): number {
    let total = 0;
    for (const [, state] of this.#steps) total += state.finalCostUsd ?? 0;
    return total;
  }
}
