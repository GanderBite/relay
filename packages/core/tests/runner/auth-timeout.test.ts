import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, type Result } from 'neverthrow';

import { createRunner } from '../../src/runner/runner.js';
import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { AuthTimeoutError, ERROR_CODES, type PipelineError } from '../../src/errors.js';
import { z } from '../../src/zod.js';
import type {
  AuthState,
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../../src/providers/types.js';

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['stuck-model'],
  maxContextTokens: 200_000,
};

/**
 * Provider whose authenticate() returns a promise that never resolves and
 * never rejects. Models the failure mode the auth-timeout cap exists to
 * defend against — a misconfigured CLI probe or a buggy custom provider that
 * wedges the Runner before any step runs.
 *
 * `invokeCalled` flips true if the Runner ever calls invoke(); the test
 * asserts it stays false because the auth race must short-circuit the run.
 */
class StuckAuthProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  invokeCalled = false;

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return new Promise(() => {
      // intentionally never settles
    });
  }

  async invoke(
    _req: InvocationRequest,
    _ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokeCalled = true;
    return ok({
      text: 'should not be reached',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      durationMs: 0,
      numTurns: 0,
      model: 'stuck-model',
      stopReason: 'end_turn',
    });
  }
}

function singleStepFlow() {
  // The prompt step builder schema requires id+kind on input, but defineFlow
  // assigns id from the record key. Pass both fields literally so the schema
  // parse succeeds — this matches the in-memory shape the Runner consumes.
  const promptSpec = step.prompt({
    id: 'a',
    kind: 'prompt',
    promptFile: 'p.md',
    output: { handoff: 'a-out' },
  } as Parameters<typeof step.prompt>[0]);
  return defineFlow({
    name: 'auth-timeout-flow',
    version: '0.1.0',
    defaultProvider: 'mock',
    input: z.object({}),
    steps: {
      a: promptSpec._unsafeUnwrap(),
    },
  })._unsafeUnwrap();
}

describe('Runner — provider.authenticate() timeout', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-auth-timeout-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('raises AuthTimeoutError when authenticate() never settles within authTimeoutMs', async () => {
    const provider = new StuckAuthProvider();
    const registry = new ProviderRegistry();
    const registered = registry.register(provider);
    expect(registered.isOk()).toBe(true);

    const runner = createRunner({
      providers: registry,
      defaultProvider: 'mock',
      runDir: tmp,
    });

    const start = Date.now();
    const thrown = await runner
      .run(singleStepFlow(), {}, { authTimeoutMs: 50 })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - start;

    expect(thrown).toBeInstanceOf(AuthTimeoutError);
    if (thrown instanceof AuthTimeoutError) {
      expect(thrown.code).toBe(ERROR_CODES.AUTH_TIMEOUT);
      expect(thrown.providerName).toBe('mock');
      expect(thrown.timeoutMs).toBe(50);
    }
    // Cap fires within ~100ms of the configured 50ms budget. A small safety
    // margin absorbs setTimeout queue jitter without weakening the contract
    // that the timeout is near-immediate, not 30s away.
    expect(elapsed).toBeLessThan(500);
    expect(provider.invokeCalled).toBe(false);
  });
});
