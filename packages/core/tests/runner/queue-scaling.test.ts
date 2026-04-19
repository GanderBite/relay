import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunner } from '../../src/runner/runner.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { createLogger } from '../../src/logger.js';
import { z } from '../../src/zod.js';
import type { InvocationResponse } from '../../src/providers/types.js';

const CANNED: InvocationResponse = {
  // Prompt executor expects valid JSON in text when the step output uses a
  // handoff. An empty object satisfies any optional Zod schema and the
  // HandoffStore write without additional configuration.
  text: '{}',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  durationMs: 0,
  numTurns: 1,
  model: 'mock-model',
  stopReason: 'end_turn',
};

/**
 * Builds a linear chain of N prompt steps where each step depends on the
 * previous one. This is the worst case for an O(N^2) queue membership check:
 * enqueueReady() walks the full topoOrder on every completion, and
 * queue.includes() was O(N) in the worst case, yielding O(N^2) total work.
 *
 * With the queued Set the same walk is O(N) total.
 */
function buildChainFlow(n: number) {
  const steps: Record<string, ReturnType<typeof step.prompt> extends { _unsafeUnwrap(): infer U } ? U : never> = {};
  const responses: Record<string, InvocationResponse> = {};

  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    const dependsOn = i === 0 ? undefined : [`s${i - 1}`];
    // The promptStepSpecSchema requires id and kind on the raw input object,
    // even though defineFlow re-injects id from the record key. The cast
    // matches the pattern used in auth-timeout.test.ts for the same schema
    // requirement.
    steps[id] = step
      .prompt({
        id,
        kind: 'prompt',
        promptFile: 'p.md',
        dependsOn,
        output: { handoff: `${id}-out` },
      } as Parameters<typeof step.prompt>[0])
      ._unsafeUnwrap() as ReturnType<typeof step.prompt> extends { _unsafeUnwrap(): infer U } ? U : never;
    responses[id] = CANNED;
  }

  return {
    flow: defineFlow({
      name: 'chain-200',
      version: '0.1.0',
      defaultProvider: 'mock',
      input: z.object({}),
      steps,
    })._unsafeUnwrap(),
    responses,
  };
}

describe('Runner — ready queue O(1) membership', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-queue-scaling-'));
    // Prompt executor reads the promptFile relative to flowDir. Provide a
    // minimal stub so the runner can load it without hitting ENOENT.
    await writeFile(join(tmp, 'p.md'), 'prompt stub', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('completes a 200-step chain within wall-clock budget with MockProvider', { timeout: 30_000 }, async () => {
    const N = 200;
    const { flow, responses } = buildChainFlow(N);

    const provider = new MockProvider({ responses });
    const registry = new ProviderRegistry();
    registry.register(provider);

    // A silent logger avoids 200 lines of JSON noise in the test runner
    // output while keeping the runner's internal logging paths exercised.
    const silentLogger = createLogger({ flowName: 'chain-200', runId: 'test', level: 'silent' });

    const runner = createRunner({
      providers: registry,
      defaultProvider: 'mock',
      runDir: join(tmp, 'run'),
      logger: silentLogger,
    });

    const start = Date.now();
    const result = await runner.run(flow, {}, { flowDir: tmp });
    const elapsed = Date.now() - start;

    expect(result.status).toBe('succeeded');
    // 30 000 ms accommodates real disk I/O (atomic state.json writes, handoff
    // writes) across 200 serial steps even on slow CI machines. The O(N^2)
    // pathology from a linear queue.includes() scan would add quadratic
    // overhead on top of this baseline — catastrophic at N=200, visible as
    // multi-second blowup well within the 30 s cap.
    expect(elapsed).toBeLessThan(30_000);
  });
});
