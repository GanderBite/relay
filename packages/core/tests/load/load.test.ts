/**
 * Load tests for the Relay orchestrator.
 *
 * These tests exercise high-step-count flows under MockProvider (zero real
 * latency) to catch performance regressions in the DAG walker, state machine,
 * and handoff store. Wall-clock thresholds are conservative — the purpose is
 * regression detection, not benchmarking.
 *
 * A silent logger is used to suppress JSON noise and avoid per-step log I/O
 * from dominating the wall-clock measurement.
 *
 * Four scenarios:
 *   1. 100-step linear DAG — sequential chain.
 *   2. 50-iteration loop — single body step.
 *   3. 10-branch parallel — concurrent fan-out.
 *   4. 10-step DAG correctness — each step's handoff matches the MockProvider response.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createLogger } from '../../src/logger.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

// ── shared constants ───────────────────────────────────────────────────────────

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const RUN_OPTS = {
  authTimeoutMs: 1_000,
  flagProvider: 'mock',
  worktree: false,
} as const;

function mkResponse(text: string): InvocationResponse {
  return {
    text,
    usage: ZERO_USAGE,
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    model: 'mock',
    stopReason: 'end_turn',
  };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('load tests', () => {
  let runDir: string;
  let flowDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-load-run-'));
    flowDir = await mkdtemp(join(tmpdir(), 'relay-load-flow-'));
    // A single shared prompt file suffices for every prompt step — the
    // load tests never read template content so a minimal body is fine.
    await writeFile(join(flowDir, 'p.md'), 'test prompt', 'utf8');
    await mkdir(join(runDir, 'live'), { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(flowDir, { recursive: true, force: true });
  });

  // ── Test 1: 100-step linear DAG ──────────────────────────────────────────────

  it('100-step linear DAG completes in under 60s wall-clock', { timeout: 120_000 }, async () => {
    const N = 100;

    // Build N sequential prompt steps: step_0 -> step_1 -> ... -> step_99.
    const steps: Record<string, ReturnType<typeof step.prompt>> = {};
    const responses: Record<string, InvocationResponse> = {};

    for (let i = 0; i < N; i++) {
      const id = `step_${i}`;
      steps[id] = step.prompt({
        promptFile: 'p.md',
        ...(i > 0 ? { dependsOn: [`step_${i - 1}`] } : {}),
        output: { handoff: `out_${i}` },
      });
      responses[id] = mkResponse(`{"index":${i}}`);
    }

    const flow = defineFlow({
      name: 'linear-100',
      version: '0.1.0',
      input: z.object({}),
      steps,
    });

    const provider = new MockProvider({ responses });
    const registry = new ProviderRegistry();
    registry.register(provider);

    // Silent logger avoids per-step JSON log I/O from distorting wall-clock.
    const silentLogger = createLogger({ flowName: 'linear-100', runId: 'load', level: 'silent' });

    const orchestrator = createOrchestrator({ providers: registry, runDir, logger: silentLogger });

    const start = Date.now();
    const result = await orchestrator.run(flow, {}, { ...RUN_OPTS, flowDir });
    const elapsed = Date.now() - start;

    expect(result.status, `run failed after ${elapsed}ms`).toBe('succeeded');
    // 60 s accommodates real disk I/O (atomic state.json + handoff writes)
    // across 100 serial steps on slow CI machines. An O(N^2) regression
    // in the DAG walker or state machine would be visible as a multi-second
    // blowup well within this cap.
    expect(elapsed, `100-step linear DAG took ${elapsed}ms, expected < 60000ms`).toBeLessThan(
      60_000,
    );
  });

  // ── Test 2: 50-iteration loop ─────────────────────────────────────────────────

  it('50-iteration loop completes in under 30s wall-clock', { timeout: 60_000 }, async () => {
    // The loop body has one prompt step that writes a handoff keyed 'status'.
    // The until condition is { from: 'status', when: { done: true } }.
    // MockProvider returns { done: false } for iterations 1-49 and
    // { done: true } on iteration 50 so the loop exits at maxIterations.
    let callCount = 0;

    const flow = defineFlow({
      name: 'loop-50',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        main_loop: step.loop({
          body: {
            body_step: step.prompt({
              promptFile: 'p.md',
              output: { handoff: 'status' },
            }),
          },
          until: { from: 'status', when: { done: true } },
          maxIterations: 50,
        }),
      },
    });

    const provider = new MockProvider({
      responses: {
        body_step: () => {
          callCount += 1;
          // Emit { done: true } on the 50th call so the until condition matches.
          const done = callCount >= 50;
          return mkResponse(JSON.stringify({ done }));
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const silentLogger = createLogger({ flowName: 'loop-50', runId: 'load', level: 'silent' });
    const orchestrator = createOrchestrator({ providers: registry, runDir, logger: silentLogger });

    const start = Date.now();
    const result = await orchestrator.run(flow, {}, { ...RUN_OPTS, flowDir });
    const elapsed = Date.now() - start;

    expect(result.status, `loop run failed after ${elapsed}ms`).toBe('succeeded');
    expect(callCount, 'body_step must be called 50 times').toBe(50);
    expect(elapsed, `50-iteration loop took ${elapsed}ms, expected < 30000ms`).toBeLessThan(30_000);
  });

  // ── Test 3: 10-branch parallel ────────────────────────────────────────────────

  it('10-branch parallel step completes in under 10s wall-clock', { timeout: 20_000 }, async () => {
    const BRANCHES = 10;

    // Build 10 sibling prompt steps that the parallel coordinator fans out to.
    const branchIds = Array.from({ length: BRANCHES }, (_, i) => `branch_${i}`);
    const branchSteps: Record<string, ReturnType<typeof step.prompt>> = {};
    const responses: Record<string, InvocationResponse> = {};

    for (const id of branchIds) {
      branchSteps[id] = step.prompt({
        promptFile: 'p.md',
        output: { handoff: `${id}_out` },
      });
      responses[id] = mkResponse(`{"branch":"${id}"}`);
    }

    const flow = defineFlow({
      name: 'parallel-10',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        fan_out: step.parallel({ branches: branchIds }),
        ...branchSteps,
      },
    });

    const provider = new MockProvider({ responses });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const silentLogger = createLogger({ flowName: 'parallel-10', runId: 'load', level: 'silent' });
    const orchestrator = createOrchestrator({ providers: registry, runDir, logger: silentLogger });

    const start = Date.now();
    const result = await orchestrator.run(flow, {}, { ...RUN_OPTS, flowDir });
    const elapsed = Date.now() - start;

    expect(result.status, `parallel run failed after ${elapsed}ms`).toBe('succeeded');
    expect(elapsed, `10-branch parallel took ${elapsed}ms, expected < 10000ms`).toBeLessThan(
      10_000,
    );
  });

  // ── Test 4: 10-step DAG — handoff correctness ─────────────────────────────────

  it('10-step DAG produces correct handoffs for each step', async () => {
    const N = 10;

    // Each step writes a handoff whose content encodes its own index. After
    // the run, read each handoff from disk and verify it matches.
    const steps: Record<string, ReturnType<typeof step.prompt>> = {};
    const responses: Record<string, InvocationResponse> = {};

    for (let i = 0; i < N; i++) {
      const id = `s${i}`;
      steps[id] = step.prompt({
        promptFile: 'p.md',
        ...(i > 0 ? { dependsOn: [`s${i - 1}`] } : {}),
        output: { handoff: `h${i}` },
      });
      // Response is a JSON object whose 'value' key encodes the step index.
      responses[id] = mkResponse(`{"value":${i}}`);
    }

    const flow = defineFlow({
      name: 'correctness-10',
      version: '0.1.0',
      input: z.object({}),
      steps,
    });

    const provider = new MockProvider({ responses });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const silentLogger = createLogger({
      flowName: 'correctness-10',
      runId: 'load',
      level: 'silent',
    });
    const orchestrator = createOrchestrator({ providers: registry, runDir, logger: silentLogger });

    const result = await orchestrator.run(flow, {}, { ...RUN_OPTS, flowDir });

    expect(result.status).toBe('succeeded');

    // Verify each handoff on disk matches the MockProvider response for that step.
    for (let i = 0; i < N; i++) {
      const handoffPath = join(runDir, 'handoffs', `h${i}.json`);
      const raw = await readFile(handoffPath, 'utf8');
      const parsed = JSON.parse(raw) as { value: number };
      expect(parsed.value, `handoff h${i} should have value ${i}, got ${parsed.value}`).toBe(i);
    }
  });
});
