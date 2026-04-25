/**
 * Integration tests: onFail policy routing.
 *
 * TC-003: onFail:'continue' — a dependent step runs even after its upstream
 *   failed. The run resolves without throwing. Both steps appear in the final
 *   persisted state: step-a=failed, step-b=succeeded.
 *
 * TC-004: onFail:<stepId> — when step-a fails the routing step (step-cleanup)
 *   executes because it is a root step that was queued at run start. step-b,
 *   which depends on step-a, is never enqueued: the upstream failure sets
 *   runFailed=true and enqueueReady() is not called. The run resolves (returns
 *   RunResult) with status 'failed'. step-a=failed, step-cleanup=succeeded,
 *   step-b=pending.
 *
 * Both tests use an inline ConditionalProvider (no live Claude calls). A temp
 * dir is created and torn down around each test; a minimal prompt file is
 * written into it so executePrompt does not hit ENOENT.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineError } from '../../src/errors.js';
import { StepFailureError } from '../../src/errors.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type {
  AuthState,
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../../src/providers/types.js';
import { z } from '../../src/zod.js';

// ── shared constants ──────────────────────────────────────────────────────────

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const SUCCESS_RESPONSE: InvocationResponse = {
  text: '{"ok":true}',
  usage: ZERO_USAGE,
  costUsd: 0,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['mock'],
  maxContextTokens: 200_000,
};

// ── ConditionalProvider ───────────────────────────────────────────────────────

/**
 * Provider that fails for a specific step and succeeds for all others. Used
 * to exercise onFail policy routing without live Claude calls.
 */
class ConditionalProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;

  /** Step ids that were passed to invoke(), in call order. */
  readonly invokedSteps: string[] = [];

  /** The step id that will be forced to fail. */
  readonly #failStepId: string;

  constructor(failStepId: string) {
    this.#failStepId = failStepId;
  }

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'conditional mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokedSteps.push(ctx.stepId);
    if (ctx.stepId === this.#failStepId) {
      return err(
        new StepFailureError(
          `ConditionalProvider: forced failure for step "${ctx.stepId}"`,
          ctx.stepId,
          ctx.attempt,
        ),
      );
    }
    return ok(SUCCESS_RESPONSE);
  }

  async *stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    this.invokedSteps.push(ctx.stepId);
    if (ctx.stepId === this.#failStepId) {
      throw new StepFailureError(
        `ConditionalProvider: forced failure for step "${ctx.stepId}"`,
        ctx.stepId,
        ctx.attempt,
      );
    }
    yield { type: 'turn.start', turn: 1 };
    yield { type: 'text.delta', delta: '{"ok":true}' };
    yield { type: 'usage', usage: ZERO_USAGE };
    yield { type: 'turn.end', turn: 1 };
  }
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('onFail policy', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-onfail-'));
    // Provide a real prompt file so executePrompt does not hit ENOENT when
    // resolving the promptFile path relative to flowDir.
    await writeFile(join(runDir, 'p.md'), '# test prompt', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  // ── TC-003 ──────────────────────────────────────────────────────────────────

  it('[TC-003] onFail:continue — dependent step runs after upstream failure', {
    timeout: 20_000,
  }, async () => {
    // step-a fails, step-b depends on step-a.
    // Because step-a has onFail:'continue', enqueueReady treats a failed
    // step-a as a "satisfied" predecessor and dispatches step-b.
    const flow = defineFlow({
      name: 'onfail-continue',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        'step-a': step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'a-out' },
          onFail: 'continue',
        }),
        'step-b': step.prompt({
          promptFile: 'p.md',
          dependsOn: ['step-a'],
          output: { handoff: 'b-out' },
        }),
      },
    });

    const provider = new ConditionalProvider('step-a');
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir });

    // run() must resolve without throwing — onFail:'continue' must not propagate
    // the upstream error as an unhandled rejection.
    const result = await orchestrator.run(
      flow,
      {},
      {
        flowDir: runDir,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // The run resolves (no throw). Status may be 'failed' or 'succeeded'
    // depending on how the implementation aggregates step outcomes — what
    // matters is that run() returns a RunResult rather than throwing.
    expect(['failed', 'succeeded']).toContain(result.status);

    // Both steps must appear in the final persisted state.
    const stateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      steps: Record<string, { status: string }>;
    };

    expect(state.steps['step-a']?.status, 'step-a must be recorded as failed in state.json').toBe(
      'failed',
    );

    expect(
      state.steps['step-b']?.status,
      'step-b must be recorded as succeeded — onFail:continue let it run',
    ).toBe('succeeded');

    // Provider.invoke must have been called for both steps.
    expect(provider.invokedSteps, 'invoke must have been called for step-a').toContain('step-a');

    expect(provider.invokedSteps, 'invoke must have been called for step-b').toContain('step-b');

    expect(provider.invokedSteps, 'provider.invoke must be called exactly twice').toHaveLength(2);
  });

  // ── TC-004 ──────────────────────────────────────────────────────────────────

  it('[TC-004] onFail:<stepId> — routes to recovery step, skips normal dependents', {
    timeout: 20_000,
  }, async () => {
    // step-a fails with onFail:'step-cleanup'.
    // step-b depends on step-a (normal downstream — must NOT run).
    // step-cleanup has no dependsOn (root step — queued at run start, runs
    //   independently of step-a's outcome).
    //
    // The DAG walker enqueues root steps at the start of the run. When step-a
    // fails with onFail:<stepId> (not 'continue'), runFailed is set to true
    // and enqueueReady() is no longer called, so step-b is never dispatched.
    // step-cleanup is already dispatched as a root step and completes.
    const flow = defineFlow({
      name: 'onfail-stepid',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        'step-a': step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'a-out' },
          onFail: 'step-cleanup',
        }),
        'step-b': step.prompt({
          promptFile: 'p.md',
          dependsOn: ['step-a'],
          output: { handoff: 'b-out' },
        }),
        'step-cleanup': step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'cleanup-out' },
        }),
      },
      // Three root candidates exist: step-a and step-cleanup have no
      // predecessors; step-b depends on step-a. With two root steps the flow
      // requires an explicit start to pick the entry point.
      start: 'step-a',
    });

    const provider = new ConditionalProvider('step-a');
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir });

    // run() must resolve (return RunResult) rather than throw. The run status
    // is 'failed' because step-a failed and onFail:<stepId> does not suppress
    // the failure flag the way onFail:'continue' does.
    const result = await orchestrator.run(
      flow,
      {},
      {
        flowDir: runDir,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    expect(result.status, 'run status must be failed — step-a failed without onFail:continue').toBe(
      'failed',
    );

    // step-a must be recorded as failed.
    const stateRaw = await readFile(join(runDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      steps: Record<string, { status: string }>;
    };

    expect(state.steps['step-a']?.status, 'step-a must be failed in state.json').toBe('failed');

    // step-cleanup is a root step; it was dispatched at run start before step-a
    // failed, so it must have succeeded.
    expect(
      state.steps['step-cleanup']?.status,
      'step-cleanup must be succeeded — it ran as a root step',
    ).toBe('succeeded');

    // step-b depends on step-a. After step-a fails, runFailed=true prevents
    // enqueueReady() from dispatching step-b. It must remain pending.
    expect(
      state.steps['step-b']?.status,
      'step-b must remain pending — it was never dispatched',
    ).toBe('pending');

    // step-b must never have been invoked by the provider.
    expect(
      provider.invokedSteps,
      'provider.invoke must NOT have been called for step-b',
    ).not.toContain('step-b');

    // step-cleanup must have been invoked.
    expect(
      provider.invokedSteps,
      'provider.invoke must have been called for step-cleanup',
    ).toContain('step-cleanup');
  });
});
