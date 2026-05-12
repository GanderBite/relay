/**
 * progress/index.ts — public surface for the progress display.
 *
 * Re-exports AuthInfo and WatchEvent, and provides the ProgressDisplay class
 * that wires startWatcher to ProgressRenderer as a thin composition layer.
 *
 * External callers (commands/run.ts, commands/resume.ts) import ProgressDisplay
 * and AuthInfo from ../progress.js, which re-exports from this file.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Flow } from '@ganderbite/relay-core';
import type { AuthInfo } from './render.js';
import { ProgressRenderer } from './render.js';
import type { WatcherHandle } from './watch.js';
import { startWatcher } from './watch.js';

export type { AuthInfo } from './render.js';
export { ProgressRenderer } from './render.js';
export type { WatchEvent } from './watch.js';
export { startWatcher } from './watch.js';

// ---------------------------------------------------------------------------
// ProgressDisplay
// ---------------------------------------------------------------------------

/**
 * Three-zone live progress display.
 *
 * Thin composition of startWatcher (progress/watch.ts) and ProgressRenderer
 * (progress/render.ts). Preserves the public API of the original ProgressDisplay
 * so existing import sites in commands/run.ts and commands/resume.ts compile
 * without changes.
 *
 * Constructor: `new ProgressDisplay(runDir, flow, auth, verbose?)`
 * Start:       `.start(runId)` — begins watching and rendering.
 * Stop:        `.stop()` — clears the live area and returns terminal control.
 * Metrics:     `.updateRunnerMetrics(runnerId, { tokensIn, tokensOut, costUsd, durationMs, model })`
 * SIGINT:      `.onSigint(handler)` — register a ctrl-c handler wired on start() and unwired on stop().
 */
export class ProgressDisplay<TInput = unknown> {
  readonly #runDir: string;
  readonly #flow: Flow<TInput>;
  readonly #verbose: boolean;

  readonly #renderer: ProgressRenderer<TInput>;
  #watcher: WatcherHandle | null = null;

  readonly #sigintHandlers: Array<() => void> = [];

  constructor(runDir: string, flow: Flow<TInput>, auth: AuthInfo, verbose = false) {
    this.#runDir = runDir;
    this.#flow = flow;
    this.#verbose = verbose;
    this.#renderer = new ProgressRenderer(flow, auth, verbose);
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
    for (const handler of this.#sigintHandlers) {
      process.on('SIGINT', handler);
    }

    this.#renderer.start(runId);

    const stepIds = new Set(this.#flow.graph.topoOrder);

    // Body steps of loop steps are NOT in topoOrder — include them so the
    // watcher accepts their live-state files.
    for (const runnerId of this.#flow.graph.topoOrder) {
      const step = this.#flow.steps[runnerId];
      if (step !== undefined && step.kind === 'loop') {
        for (const bodyId of Object.keys(step.body)) {
          stepIds.add(bodyId);
        }
      }
    }

    // Pre-create the live directory so chokidar has a real path to watch from
    // the start. The orchestrator calls mkdir(live/) idempotently later; this
    // avoids the FSEvents race where files written to a newly-created directory
    // are missed. Fire-and-forget: any mkdir failure is non-fatal.
    void mkdir(join(this.#runDir, 'live'), { recursive: true }).catch(() => undefined);

    this.#watcher = startWatcher(
      this.#runDir,
      (event) => this.#renderer.onEvent(event),
      this.#verbose,
      stepIds,
    );
  }

  /**
   * Stop the display.
   * Clears the live area (TTY), unwires SIGINT handlers, and closes the watcher.
   * Returns a promise that resolves after the events watcher is fully drained.
   */
  async stop(): Promise<void> {
    this.#renderer.stop();

    if (this.#watcher !== null) {
      await this.#watcher.stop();
      this.#watcher = null;
    }

    for (const handler of this.#sigintHandlers) {
      process.off('SIGINT', handler);
    }
  }

  /**
   * Push final per-step metrics from the run command after each step completes.
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
    this.#renderer.updateRunnerMetrics(runnerId, metrics);
  }
}
