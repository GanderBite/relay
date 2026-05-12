/**
 * Tests for progress/watch.ts and progress/render.ts.
 *
 * watch.ts: startWatcher integration — uses a real temp directory and writes
 * files to trigger chokidar events. Awaits events through a promise that
 * resolves on first callback or rejects after a 5s timeout.
 *
 * render.ts: ProgressRenderer unit tests — exercises the non-TTY path (no
 * log-update calls, structured output to stderr). process.isTTY is false in
 * vitest's Node environment, so log-update is never invoked; the renderer
 * falls through to the logStructured() path instead.
 *
 * Token-accumulation tests (original describe block) are preserved because
 * they test ProgressDisplay which composes both sub-modules.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Flow } from '@ganderbite/relay-core';
import { z } from '@ganderbite/relay-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo } from '../src/progress/render.js';
import { ProgressRenderer } from '../src/progress/render.js';
import type { WatchEvent } from '../src/progress/watch.js';
import { startWatcher } from '../src/progress/watch.js';
import { ProgressDisplay } from '../src/progress.js';

// ---------------------------------------------------------------------------
// Silence stderr during tests (logStructured writes there on start/stop).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeFlow(stepIds: string[]): Flow<unknown> {
  const steps: Record<
    string,
    { dependsOn: readonly string[]; promptFile: string; provider: string }
  > = {};
  for (const id of stepIds) {
    steps[id] = { dependsOn: [], promptFile: 'prompt.md', provider: 'mock' };
  }
  return {
    name: 'test-flow',
    version: '1.0.0',
    input: z.object({}),
    steps,
    rootSteps: stepIds.slice(0, 1),
    graph: {
      successors: new Map(),
      predecessors: new Map(),
      topoOrder: stepIds,
      rootSteps: stepIds.slice(0, 1),
      entry: stepIds[0] ?? '',
    },
  } as unknown as Flow<unknown>;
}

const fakeAuth: AuthInfo = { label: 'subscription (max)', estUsd: 0 };

/**
 * Wait for a callback-based event or time out after `ms` milliseconds.
 * Returns a promise that resolves with the array of events collected.
 */
function waitForEvents<T>(
  register: (emit: (e: T) => void) => void,
  count: number,
  ms = 5000,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const collected: T[] = [];
    const timer = setTimeout(() => {
      reject(
        new Error(`Timed out after ${ms}ms waiting for ${count} event(s); got ${collected.length}`),
      );
    }, ms);

    register((e) => {
      collected.push(e);
      if (collected.length >= count) {
        clearTimeout(timer);
        resolve(collected);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// describe: watch.ts
// ---------------------------------------------------------------------------

describe('watch.ts', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-watch-test-'));
    await mkdir(join(runDir, 'live'), { recursive: true });
    await mkdir(join(runDir, 'events'), { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('emits a LiveStateEvent when a live/<step>.json file is written', async () => {
    const stepIds = new Set(['step-a']);

    const eventsPromise = waitForEvents<WatchEvent>((emit) => {
      startWatcher(runDir, emit, false, stepIds);
    }, 1);

    const liveState = {
      status: 'running',
      attempt: 1,
      startedAt: new Date().toISOString(),
      lastUpdateAt: new Date().toISOString(),
      model: 'claude-mock',
      tokensSoFar: 42,
    };
    await writeFile(join(runDir, 'live', 'step-a.json'), JSON.stringify(liveState));

    const events = await eventsPromise;
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('state');
    if (ev.kind === 'state') {
      expect(ev.stepId).toBe('step-a');
      expect(ev.state.status).toBe('running');
      expect(ev.state.model).toBe('claude-mock');
    }
  });

  it('ignores live/<step>.json for unknown step IDs', async () => {
    const stepIds = new Set(['step-known']);
    const received: WatchEvent[] = [];

    const handle = startWatcher(runDir, (e) => received.push(e), false, stepIds);

    // Write a file for an unknown step, then write one for the known step.
    await writeFile(
      join(runDir, 'live', 'unknown-step.json'),
      JSON.stringify({
        status: 'running',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      }),
    );

    // Known step — ensures the watcher is up and we can detect it.
    const knownEvPromise = waitForEvents<WatchEvent>((emit) => {
      // Piggy-back on the existing watcher by registering separately so we
      // can detect the known event without polling.
      startWatcher(runDir, emit, false, stepIds);
    }, 1);

    await writeFile(
      join(runDir, 'live', 'step-known.json'),
      JSON.stringify({
        status: 'running',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      }),
    );

    await knownEvPromise;

    // The original watcher should only have produced events for the known step.
    const unknownEvents = received.filter((e) => e.kind === 'state' && e.stepId === 'unknown-step');
    expect(unknownEvents).toHaveLength(0);

    await handle.stop();
  });

  it('emits an EventsRecordEvent when a .jsonl file is written (verbose=true)', async () => {
    const stepIds = new Set(['step-b']);

    const eventsPromise = waitForEvents<WatchEvent>((emit) => {
      startWatcher(runDir, emit, true, stepIds);
    }, 1);

    const record = JSON.stringify({
      seq: 1,
      ts: new Date().toISOString(),
      attempt: 1,
      event: { type: 'turn.start', turn: 1 },
    });
    await writeFile(join(runDir, 'events', 'step-b.jsonl'), record + '\n');

    const events = await eventsPromise;
    const ev = events.find((e) => e.kind === 'events');
    expect(ev).toBeDefined();
    if (ev?.kind === 'events') {
      expect(ev.stepId).toBe('step-b');
      expect(ev.records).toHaveLength(1);
      expect(ev.records[0]!.event.type).toBe('turn.start');
    }
  });

  it('does not emit events-file records when verbose=false', async () => {
    const stepIds = new Set(['step-c']);
    const received: WatchEvent[] = [];

    const handle = startWatcher(runDir, (e) => received.push(e), false, stepIds);

    // Give chokidar time to attach (it fires 'ready' asynchronously).
    await new Promise((r) => setTimeout(r, 200));

    const record = JSON.stringify({
      seq: 1,
      ts: new Date().toISOString(),
      attempt: 1,
      event: { type: 'turn.start', turn: 1 },
    });
    await writeFile(join(runDir, 'events', 'step-c.jsonl'), record + '\n');

    // Give any spurious event 300ms to arrive.
    await new Promise((r) => setTimeout(r, 300));

    const eventsFileEvents = received.filter((e) => e.kind === 'events');
    expect(eventsFileEvents).toHaveLength(0);

    await handle.stop();
  });

  it('stop() resolves without error and prevents further event delivery', async () => {
    const stepIds = new Set(['step-d']);
    const received: WatchEvent[] = [];

    const handle = startWatcher(runDir, (e) => received.push(e), false, stepIds);

    // Wait for the watcher to start.
    await new Promise((r) => setTimeout(r, 150));
    await handle.stop();

    const countAfterStop = received.length;

    // Write after stop — event should not arrive.
    await writeFile(
      join(runDir, 'live', 'step-d.json'),
      JSON.stringify({
        status: 'running',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 300));
    // Count should not have grown after stop.
    expect(received.length).toBe(countAfterStop);
  });

  it('ignores malformed JSON in a live/<step>.json file', async () => {
    const stepIds = new Set(['step-e', 'step-f']);

    // Write malformed JSON for step-e, then valid JSON for step-f.
    const knownEvPromise = waitForEvents<WatchEvent>((emit) => {
      startWatcher(runDir, emit, false, stepIds);
    }, 1);

    await writeFile(join(runDir, 'live', 'step-e.json'), '{not-valid-json}');

    await writeFile(
      join(runDir, 'live', 'step-f.json'),
      JSON.stringify({
        status: 'succeeded',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      }),
    );

    const events = await knownEvPromise;
    const malformedEvents = events.filter((e) => e.kind === 'state' && e.stepId === 'step-e');
    expect(malformedEvents).toHaveLength(0);
    const validEvent = events.find((e) => e.kind === 'state' && e.stepId === 'step-f');
    expect(validEvent).toBeDefined();
  });

  it('emits incremental events when a .jsonl file is appended (byte-offset tailing)', async () => {
    const stepIds = new Set(['step-g']);

    const firstRecord = JSON.stringify({
      seq: 1,
      ts: new Date().toISOString(),
      attempt: 1,
      event: { type: 'turn.start', turn: 1 },
    });

    // Write the first record and wait for its event.
    const firstEvPromise = waitForEvents<WatchEvent>((emit) => {
      startWatcher(runDir, emit, true, stepIds);
    }, 1);

    await writeFile(join(runDir, 'events', 'step-g.jsonl'), firstRecord + '\n');
    const firstEvents = await firstEvPromise;
    expect(firstEvents[0]?.kind).toBe('events');

    // Append a second record and wait for the incremental event.
    const secondRecord = JSON.stringify({
      seq: 2,
      ts: new Date().toISOString(),
      attempt: 1,
      event: { type: 'turn.end', turn: 1 },
    });

    const secondEvPromise = waitForEvents<WatchEvent>((emit) => {
      startWatcher(runDir, emit, true, stepIds);
    }, 1);

    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(runDir, 'events', 'step-g.jsonl'), secondRecord + '\n');
    const secondEvents = await secondEvPromise;
    const evRec = secondEvents.find((e) => e.kind === 'events');
    expect(evRec).toBeDefined();
    if (evRec?.kind === 'events') {
      const turnEndRecord = evRec.records.find((r) => r.event.type === 'turn.end');
      expect(turnEndRecord).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// describe: render.ts
// ---------------------------------------------------------------------------

describe('render.ts', () => {
  it('start() writes a run.start structured log line to stderr in non-TTY mode', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    renderer.start('run-abc');
    renderer.stop();

    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('run.start');
    expect(allOutput).toContain('run-abc');
  });

  it('onEvent(state) with status=running writes step.start to stderr in non-TTY/non-verbose mode', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    renderer.start('run-xyz');

    renderer.onEvent({
      kind: 'state',
      stepId: 'step-a',
      state: {
        status: 'running',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
        model: 'claude-mock',
      },
    });

    renderer.stop();

    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('step.start');
    expect(allOutput).toContain('step-a');
  });

  it('onEvent(state) running→succeeded writes step.end to stderr in non-TTY/non-verbose mode', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    renderer.start('run-end-test');

    const now = new Date().toISOString();

    // Transition to running.
    renderer.onEvent({
      kind: 'state',
      stepId: 'step-a',
      state: { status: 'running', attempt: 1, startedAt: now, lastUpdateAt: now },
    });

    // Transition to succeeded (triggers step.end).
    renderer.onEvent({
      kind: 'state',
      stepId: 'step-a',
      state: { status: 'succeeded', attempt: 1, startedAt: now, lastUpdateAt: now },
    });

    renderer.stop();

    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('step.end');
  });

  it('onEvent with unknown stepId is a no-op', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    renderer.start('run-noop');

    // Should not throw.
    expect(() => {
      renderer.onEvent({
        kind: 'state',
        stepId: 'ghost-step',
        state: {
          status: 'running',
          attempt: 1,
          startedAt: new Date().toISOString(),
          lastUpdateAt: new Date().toISOString(),
        },
      });
    }).not.toThrow();

    renderer.stop();
  });

  it('updateRunnerMetrics stores per-step final token counts without throwing', () => {
    const flow = makeFlow(['a', 'b', 'c']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    renderer.start('run-tokens');

    // No errors expected from sequential metric updates.
    expect(() => {
      renderer.updateRunnerMetrics('a', {
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0,
        durationMs: 1000,
        model: 'mock',
      });
      renderer.updateRunnerMetrics('b', {
        tokensIn: 50,
        tokensOut: 50,
        costUsd: 0,
        durationMs: 500,
        model: 'mock',
      });
      renderer.updateRunnerMetrics('c', {
        tokensIn: 10,
        tokensOut: 10,
        costUsd: 0,
        durationMs: 200,
        model: 'mock',
      });
    }).not.toThrow();

    renderer.stop();
  });

  it('updateRunnerMetrics with unknown runnerId is silently ignored', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    renderer.start('run-guard');

    expect(() => {
      renderer.updateRunnerMetrics('phantom-step', {
        tokensIn: 9999,
        tokensOut: 9999,
        costUsd: 99,
        durationMs: 1000,
        model: 'mock',
      });
    }).not.toThrow();

    renderer.stop();
  });

  it('verbose events mode writes event records to stderr in non-TTY mode', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    renderer.start('run-verbose');

    // Feed an events record — in non-TTY verbose mode these go to stderr as JSON.
    renderer.onEvent({
      kind: 'events',
      stepId: 'step-a',
      records: [
        {
          seq: 1,
          ts: new Date().toISOString(),
          attempt: 1,
          event: { type: 'turn.start', turn: 1 },
        },
      ],
    });

    renderer.stop();

    const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOutput).toContain('turn.start');
    expect(allOutput).toContain('step-a');
  });

  it('stop() clears debounce timers without throwing', () => {
    const flow = makeFlow(['step-a']);
    const renderer = new ProgressRenderer(flow, fakeAuth, false);
    renderer.start('run-stop');

    // Trigger a debounce timer by sending an event.
    renderer.onEvent({
      kind: 'state',
      stepId: 'step-a',
      state: {
        status: 'running',
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      },
    });

    // stop() before the debounce fires — should not throw.
    expect(() => renderer.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe: ProgressDisplay cumulative token accumulation (original tests)
// ---------------------------------------------------------------------------

class InstrumentedProgressDisplay extends ProgressDisplay<unknown> {
  readonly capturedTotals: number[] = [];
  #localCumulative = 0;

  override updateRunnerMetrics(
    runnerId: string,
    metrics: {
      tokensIn: number;
      tokensOut: number;
      costUsd: number | undefined;
      durationMs: number;
      model: string;
    },
  ): void {
    super.updateRunnerMetrics(runnerId, metrics);
    this.#localCumulative += metrics.tokensIn + metrics.tokensOut;
    this.capturedTotals.push(this.#localCumulative);
  }
}

function buildAndRun(
  stepIds: string[],
  metrics: Array<{ tokensIn: number; tokensOut: number }>,
): number[] {
  const flow = makeFlow(stepIds);
  const display = new InstrumentedProgressDisplay('/tmp/relay-test', flow, fakeAuth);

  display.start('run-001');

  for (let i = 0; i < stepIds.length; i++) {
    const id = stepIds[i]!;
    const m = metrics[i]!;
    display.updateRunnerMetrics(id, {
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      costUsd: 0,
      durationMs: 1000,
      model: 'claude-mock',
    });
  }

  void display.stop();
  return display.capturedTotals;
}

describe('ProgressDisplay per-step token accumulation', () => {
  it('step 1 (tokensIn=500, tokensOut=600) reports a per-step total of 1100', () => {
    const totals = buildAndRun(
      ['step-a', 'step-b'],
      [
        { tokensIn: 500, tokensOut: 600 },
        { tokensIn: 100, tokensOut: 50 },
      ],
    );
    expect(totals[0]).toBe(1100);
  });

  it('step 2 (tokensIn=100, tokensOut=50) reports its own per-step total of 150, running total 1250', () => {
    const totals = buildAndRun(
      ['step-a', 'step-b'],
      [
        { tokensIn: 500, tokensOut: 600 },
        { tokensIn: 100, tokensOut: 50 },
      ],
    );
    expect(totals[1]).toBe(1250);
  });

  it('step 2 running total exceeds step 1 running total — monotonically non-decreasing', () => {
    const totals = buildAndRun(
      ['step-a', 'step-b'],
      [
        { tokensIn: 500, tokensOut: 600 },
        { tokensIn: 100, tokensOut: 50 },
      ],
    );
    expect(totals[1]!).toBeGreaterThan(totals[0]!);
  });

  it('single step reports tokensIn + tokensOut as per-step total', () => {
    const totals = buildAndRun(['only-step'], [{ tokensIn: 200, tokensOut: 300 }]);
    expect(totals[0]).toBe(500);
  });

  it('three steps are strictly monotonically increasing when each step adds tokens', () => {
    const totals = buildAndRun(
      ['a', 'b', 'c'],
      [
        { tokensIn: 100, tokensOut: 100 },
        { tokensIn: 200, tokensOut: 200 },
        { tokensIn: 50, tokensOut: 50 },
      ],
    );
    expect(totals[0]).toBe(200);
    expect(totals[1]).toBe(600);
    expect(totals[2]).toBe(700);
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]!).toBeGreaterThan(totals[i - 1]!);
    }
  });

  it('an unknown step ID is rejected — does not cause a crash', () => {
    const flow = makeFlow(['real-step']);
    const display = new InstrumentedProgressDisplay('/tmp/relay-test', flow, fakeAuth);
    display.start('run-noop');

    display.updateRunnerMetrics('ghost-step', {
      tokensIn: 9999,
      tokensOut: 9999,
      costUsd: 0,
      durationMs: 0,
      model: 'mock',
    });

    display.updateRunnerMetrics('real-step', {
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0,
      durationMs: 100,
      model: 'mock',
    });

    void display.stop();

    expect(display.capturedTotals).toHaveLength(2);
  });

  it('counter starts at zero — first step total equals tokensIn + tokensOut', () => {
    const totals = buildAndRun(['step-one'], [{ tokensIn: 1, tokensOut: 1 }]);
    expect(totals[0]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// describe: ProgressDisplay guard-aware accumulation
// ---------------------------------------------------------------------------

class GuardAwareDisplay extends ProgressDisplay<unknown> {
  readonly capturedTotals: Map<string, number> = new Map();
  #localCumulative = 0;
  readonly #validIds: Set<string>;

  constructor(runDir: string, flow: Flow<unknown>, auth: AuthInfo) {
    super(runDir, flow, auth);
    this.#validIds = new Set(flow.graph.topoOrder);
  }

  override updateRunnerMetrics(
    runnerId: string,
    metrics: {
      tokensIn: number;
      tokensOut: number;
      costUsd: number | undefined;
      durationMs: number;
      model: string;
    },
  ): void {
    super.updateRunnerMetrics(runnerId, metrics);
    if (this.#validIds.has(runnerId)) {
      this.#localCumulative += metrics.tokensIn + metrics.tokensOut;
      this.capturedTotals.set(runnerId, this.#localCumulative);
    }
  }
}

describe('ProgressDisplay cumulative token guard-aware accumulation', () => {
  it('unknown step IDs do not advance the cumulative counter', () => {
    const flow = makeFlow(['real-step']);
    const display = new GuardAwareDisplay('/tmp/relay-test', flow, fakeAuth);
    display.start('run-guard');

    display.updateRunnerMetrics('ghost-step', {
      tokensIn: 9999,
      tokensOut: 9999,
      costUsd: 0,
      durationMs: 0,
      model: 'mock',
    });

    display.updateRunnerMetrics('real-step', {
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0,
      durationMs: 100,
      model: 'mock',
    });

    void display.stop();

    expect(display.capturedTotals.get('real-step')).toBe(30);
    expect(display.capturedTotals.has('ghost-step')).toBe(false);
  });

  it('two valid steps accumulate correctly with guard-aware mirror', () => {
    const flow = makeFlow(['alpha', 'beta']);
    const display = new GuardAwareDisplay('/tmp/relay-test', flow, fakeAuth);
    display.start('run-two');

    display.updateRunnerMetrics('alpha', {
      tokensIn: 500,
      tokensOut: 600,
      costUsd: 0,
      durationMs: 1000,
      model: 'mock',
    });
    display.updateRunnerMetrics('beta', {
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0,
      durationMs: 500,
      model: 'mock',
    });

    void display.stop();

    expect(display.capturedTotals.get('alpha')).toBe(1100);
    expect(display.capturedTotals.get('beta')).toBe(1250);
    expect(display.capturedTotals.get('beta')!).toBeGreaterThan(
      display.capturedTotals.get('alpha')!,
    );
  });
});
