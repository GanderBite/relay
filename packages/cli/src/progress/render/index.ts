import type { Flow, ReplayedEventRecord } from '@ganderbite/relay-core';
import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';
import logUpdate from 'log-update';
import { flowHeader, SYMBOLS } from '../../brand.js';
import { renderStepSummary, renderVerboseEvent } from '../../verboseStream.js';
import type { WatchEvent } from '../watch.js';
import { renderFooter } from './footer.js';
import { logStructured } from './helpers.js';
import { renderStepRow } from './step-row.js';
import type { AuthInfo, StepDisplayState, VerboseAccumulator } from './types.js';
import { makeAccumulator } from './types.js';

export type { AuthInfo } from './types.js';

/**
 * Stateful renderer that accepts WatchEvent values and repaints the terminal.
 *
 * Call start(runId) first, then feed events via onEvent() and push final
 * metrics via updateRunnerMetrics(). Call stop() to clear the display.
 */
export class ProgressRenderer<TInput = unknown> {
  readonly #flow: Flow<TInput>;
  readonly #verbose: boolean;
  readonly #isTTY: boolean;

  #runId = '';
  #runStartedAt = '';
  #spinnerFrame = 0;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #liveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  #eventsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #steps: Map<string, StepDisplayState> = new Map();
  #verboseAccumulators: Map<string, VerboseAccumulator> | null = null;

  constructor(flow: Flow<TInput>, _auth: AuthInfo, verbose = false) {
    this.#flow = flow;
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

  #computeTotalTokens(): number {
    let total = 0;
    for (const [, state] of this.#steps) {
      if (
        state.live?.status === 'succeeded' ||
        state.live?.status === 'failed' ||
        state.live?.status === 'skipped'
      ) {
        total += (state.finalTokensIn ?? 0) + (state.finalTokensOut ?? 0);
      } else if (state.live?.status === 'running') {
        total += state.live.tokensSoFar ?? 0;
      }
    }
    return total;
  }

  #redraw(): void {
    const lines: string[] = [];
    lines.push(flowHeader(this.#flow.name, this.#runId));
    lines.push('');
    for (const [, state] of this.#steps) {
      lines.push(
        renderStepRow(
          state,
          this.#spinnerFrame,
          this.#steps,
          this.#flow as Flow<unknown>,
          this.#verbose,
          this.#verboseAccumulators,
        ),
      );
    }
    lines.push('');
    lines.push(renderFooter(this.#runStartedAt, this.#computeTotalTokens()));
    lines.push('');
    logUpdate(lines.join('\n'));
  }
}
