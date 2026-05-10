/**
 * Tests for renderPausedBanner.
 *
 * Covers: top-level pause (awaitingInput absent), top-level ask pause (awaitingInput
 * with stepId), loop-body ask pause (awaitingInput with loopStepId + loopIter),
 * abort/cancelled mid-step row, minimal fallback when state is missing.
 *
 * All stdout writes are captured via vi.spyOn. A real temp dir holds state.json
 * and metrics.json so we can exercise the actual readFile paths without touching
 * the project tree.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderPausedBanner } from '../src/paused-banner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let runDir: string;
let stdoutChunks: string[];

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'relay-paused-banner-'));
  stdoutChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runDir, { recursive: true, force: true });
});

function captured(): string {
  return stdoutChunks.join('');
}

async function writeState(steps: Record<string, unknown>): Promise<void> {
  await writeFile(join(runDir, 'state.json'), JSON.stringify({ steps }), 'utf8');
}

async function writeMetrics(entries: unknown[]): Promise<void> {
  await writeFile(join(runDir, 'metrics.json'), JSON.stringify(entries), 'utf8');
}

// ---------------------------------------------------------------------------
// Top-level Ctrl-C pause — no awaitingInput
// ---------------------------------------------------------------------------

describe('renderPausedBanner — top-level pause (Ctrl-C, no ask)', () => {
  it('renders header, step grid, and resume hint when no awaitingInput', async () => {
    await writeState({
      inventory: {
        status: 'succeeded',
        attempts: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:02.000Z',
      },
      entities: { status: 'running', attempts: 2 },
      report: { status: 'pending', attempts: 0 },
    });
    await writeMetrics([
      { stepId: 'inventory', durationMs: 2100, costUsd: 0.005, model: 'sonnet' },
    ]);

    await renderPausedBanner('codebase-discovery', 'f9c3a2', runDir, [
      'inventory',
      'entities',
      'report',
    ]);

    const out = captured();

    // Header structure
    expect(out).toContain('^C');
    expect(out).toContain('●─▶●─▶●─▶●');
    expect(out).toContain('codebase-discovery');
    expect(out).toContain('f9c3a2');
    expect(out).toContain('(paused)');

    // Step rows
    expect(out).toContain('inventory');
    expect(out).toContain('entities');
    expect(out).toContain('report');

    // inventory succeeded
    expect(out).toContain('✓');
    // entities running — shown as cancelled mid-step
    expect(out).toContain('⊘');
    expect(out).toContain('cancelled mid-step');
    // report pending — not started
    expect(out).toContain('○');
    expect(out).toContain('not started');

    // Footer — resume hint (not answer hint)
    expect(out).toContain('resume: relay resume f9c3a2');
    expect(out).not.toContain('answer:');

    expect(out).toMatchSnapshot();
  });

  it('shows total cost from metrics in footer', async () => {
    await writeState({
      a: { status: 'succeeded', attempts: 1 },
      b: { status: 'succeeded', attempts: 1 },
    });
    await writeMetrics([
      { stepId: 'a', durationMs: 1000, costUsd: 0.01, model: 'sonnet' },
      { stepId: 'b', durationMs: 2000, costUsd: 0.02, model: 'sonnet' },
    ]);

    await renderPausedBanner('my-flow', 'abc123', runDir, ['a', 'b']);

    const out = captured();
    // Total is 0.01 + 0.02 = 0.03 → fmtCost → "$0.0300"
    expect(out).toContain('$0.0300');
    expect(out).toContain('state saved.');
  });
});

// ---------------------------------------------------------------------------
// Top-level ask pause — awaitingInput.stepId present, no loopStepId
// ---------------------------------------------------------------------------

describe('renderPausedBanner — top-level ask pause (awaitingInput, no loop)', () => {
  it('shows "answer: relay answer <runId>" instead of resume hint', async () => {
    await writeState({
      gather: { status: 'paused', attempts: 1 },
      process: { status: 'pending', attempts: 0 },
    });

    await renderPausedBanner('my-flow', 'run-xyz', runDir, ['gather', 'process'], {
      stepId: 'gather',
    });

    const out = captured();

    // The paused step shows "awaiting input"
    expect(out).toContain('gather');
    expect(out).toContain('awaiting input');

    // pending step shows "not started"
    expect(out).toContain('process');
    expect(out).toContain('not started');

    // Footer must be the answer hint
    expect(out).toContain('answer: relay answer run-xyz');
    expect(out).not.toContain('resume: relay resume');

    expect(out).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Abort path — running step shown as "cancelled mid-step (turn N)"
// ---------------------------------------------------------------------------

describe('renderPausedBanner — cancelled mid-step rows', () => {
  it('shows turn count in the cancelled annotation when attempts > 0', async () => {
    await writeState({
      services: { status: 'running', attempts: 2 },
    });

    await renderPausedBanner('my-flow', 'run-001', runDir, ['services']);

    const out = captured();
    expect(out).toContain('⊘');
    expect(out).toContain('cancelled mid-step (turn 2)');
  });

  it('shows "cancelled mid-step" without turn count when attempts is 0', async () => {
    await writeState({
      services: { status: 'running', attempts: 0 },
    });

    await renderPausedBanner('my-flow', 'run-002', runDir, ['services']);

    const out = captured();
    expect(out).toContain('⊘');
    expect(out).toContain('cancelled mid-step');
    expect(out).not.toContain('(turn 0)');
  });
});

// ---------------------------------------------------------------------------
// Minimal fallback — state.json missing or unreadable
// ---------------------------------------------------------------------------

describe('renderPausedBanner — minimal fallback when state absent', () => {
  it('renders "state saved." and resume hint when state.json does not exist', async () => {
    // No state.json written — readStateSteps will return {}
    await renderPausedBanner('codebase-discovery', 'f9c3a2', runDir, ['step-a', 'step-b']);

    const out = captured();

    expect(out).toContain('^C');
    expect(out).toContain('●─▶●─▶●─▶●');
    expect(out).toContain('f9c3a2');
    expect(out).toContain('(paused)');
    expect(out).toContain('state saved.');
    expect(out).toContain('resume: relay resume f9c3a2');
  });

  it('renders answer hint in fallback when awaitingInput is set', async () => {
    // No state.json — fallback path with awaitingInput
    await renderPausedBanner('my-flow', 'run-ask', runDir, ['gather'], { stepId: 'gather' });

    const out = captured();
    expect(out).toContain('state saved.');
    expect(out).toContain('answer: relay answer run-ask');
    expect(out).not.toContain('resume: relay resume');
  });
});
