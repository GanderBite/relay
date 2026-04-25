/**
 * TC-025: hello-world flow end-to-end.
 *
 * Runs the compiled hello-world flow (greet → summarize) against a
 * HelloWorldProvider that returns step-specific responses without invoking
 * the real Claude API. Asserts:
 *
 *   (a) run() resolves with status 'succeeded'.
 *   (b) <runDir>/handoffs/greeting.json contains { greeting: 'Hello Alice' }.
 *   (c) <runDir>/artifacts/greeting.md contains '# Greeting\n\nHello Alice'.
 *
 * The flow's prompt files are resolved relative to the hello-world example
 * directory (flowDir), so the actual prompt templates are read from disk
 * and assembled — only the provider invocation is mocked.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Import the compiled hello-world flow. The dist/ artifact is committed
// alongside the source so the test does not depend on a prior build step
// in CI; the prompts/ directory is also in the example package root and is
// read directly via flowDir.
import helloWorldFlow from '../../../../examples/hello-world/dist/flow.js';
import type { PipelineError } from '../../src/errors.js';
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

// ── constants ─────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
// Two levels up from packages/core/tests/integration → monorepo root, then
// into examples/hello-world where the prompts/ directory lives.
const HELLO_WORLD_DIR = join(HERE, '..', '..', '..', '..', 'examples', 'hello-world');

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
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

// The two step-specific response bodies. The greet step must produce valid
// JSON that matches the HandoffStore's write path; the summarize step
// produces plain markdown written verbatim as an artifact.
const GREET_RESPONSE_TEXT = '{"greeting":"Hello Alice"}';
const SUMMARIZE_RESPONSE_TEXT = '# Greeting\n\nHello Alice';

// ── HelloWorldProvider ────────────────────────────────────────────────────────

/**
 * Provider that returns step-specific responses for the hello-world flow.
 * The 'greet' step receives a JSON handoff payload; the 'summarize' step
 * receives the markdown artifact content. All other steps receive the greet
 * response as a safe fallback. No network or subprocess is involved.
 */
class HelloWorldProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  readonly invokedSteps: string[] = [];

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'hello-world mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokedSteps.push(ctx.stepId);
    return ok(this.#responseFor(ctx.stepId));
  }

  async *stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    this.invokedSteps.push(ctx.stepId);
    const text = this.#responseText(ctx.stepId);
    yield { type: 'turn.start', turn: 1 };
    yield { type: 'text.delta', delta: text };
    yield { type: 'usage', usage: ZERO_USAGE };
    yield { type: 'turn.end', turn: 1 };
  }

  #responseText(stepId: string): string {
    return stepId === 'greet' ? GREET_RESPONSE_TEXT : SUMMARIZE_RESPONSE_TEXT;
  }

  #responseFor(stepId: string): InvocationResponse {
    return {
      text: this.#responseText(stepId),
      usage: ZERO_USAGE,
      costUsd: 0,
      durationMs: 10,
      numTurns: 1,
      model: 'mock',
      stopReason: 'end_turn',
    };
  }
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('hello-world flow end-to-end', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-hello-'));
    // The orchestrator's run() calls clearLiveDir then mkdir('live') itself,
    // but creating the directory here keeps setup consistent with other
    // integration tests that pre-create it for state injection helpers.
    await mkdir(join(runDir, 'live'), { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('[TC-025] greet→summarize completes with handoff and artifact', {
    timeout: 30_000,
  }, async () => {
    const provider = new HelloWorldProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir });

    const result = await orchestrator.run(
      helloWorldFlow,
      { name: 'Alice' },
      {
        flowDir: HELLO_WORLD_DIR,
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      },
    );

    // (a) Run must complete successfully.
    expect(result.status, 'run must succeed end-to-end').toBe('succeeded');

    // (b) The 'greet' step must have been invoked and written the handoff.
    expect(provider.invokedSteps, 'greet step must be invoked').toContain('greet');

    // (c) The 'summarize' step must have been invoked after the handoff was ready.
    expect(provider.invokedSteps, 'summarize step must be invoked').toContain('summarize');

    // (d) Execution order: greet must precede summarize (dependsOn constraint).
    expect(
      provider.invokedSteps.indexOf('greet'),
      'greet must be invoked before summarize',
    ).toBeLessThan(provider.invokedSteps.indexOf('summarize'));

    // (e) Handoff content: <runDir>/handoffs/greeting.json must contain the
    //     parsed JSON that the greet step wrote via HandoffStore.write().
    const handoffRaw = await readFile(join(runDir, 'handoffs', 'greeting.json'), 'utf8');
    expect(
      JSON.parse(handoffRaw),
      'handoffs/greeting.json must contain { greeting: "Hello Alice" }',
    ).toEqual({ greeting: 'Hello Alice' });

    // (f) Artifact content: <runDir>/artifacts/greeting.md must contain the
    //     verbatim text the summarize step returned.
    const artifactContent = await readFile(join(runDir, 'artifacts', 'greeting.md'), 'utf8');
    expect(artifactContent, 'artifacts/greeting.md must contain the markdown greeting').toBe(
      '# Greeting\n\nHello Alice',
    );
  });
});
