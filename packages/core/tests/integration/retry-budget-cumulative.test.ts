/**
 * TC-006: Retry budget enforced cumulatively across crash and resume.
 *
 * A step with maxRetries:1 has a total attempt budget of 2 (1 original +
 * 1 retry). When state.json records attempts:2 for that step, a subsequent
 * resume() must not grant any additional retries beyond what the budget allows.
 *
 * The provider always fails so the run can never succeed regardless of retries.
 * The test asserts:
 *   - The provider is invoked exactly once after resume (invokeCount === 1):
 *     priorAttempts=2, maxRetries=1 → remainingRetries=0, so withRetry runs
 *     the executor once at attempt=0 with no retries left.
 *   - The final run status is 'failed'.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineError } from '../../src/errors.js';
import { StepFailureError } from '../../src/errors.js';
import type { RunState } from '../../src/flow/types.js';
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
import { atomicWriteJson } from '../../src/util/atomic-write.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

// ── shared constants ──────────────────────────────────────────────────────────

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

/**
 * Provider that always returns a StepFailureError so the run can never
 * succeed regardless of retries. Tracks how many times invoke() is called
 * so the test can assert the retry-budget cap is honored.
 */
class AlwaysFailProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;
  invokeCount = 0;

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'always-fail mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    this.invokeCount++;
    return err(new StepFailureError('always fails', ctx.stepId, this.invokeCount));
  }

  stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    this.invokeCount++;
    throw new StepFailureError('always fails (stream)', ctx.stepId, this.invokeCount);
  }
}

// ── helper: write the boilerplate files a resumed run expects ─────────────────

async function writeRunBoilerplate(
  runDir: string,
  flowName: string,
  flowVersion: string,
  flowPath: string,
): Promise<void> {
  await atomicWriteJson(join(runDir, 'flow-ref.json'), {
    flowName,
    flowVersion,
    flowPath,
  });
  await atomicWriteJson(join(runDir, 'metrics.json'), []);
  await mkdir(join(runDir, 'live'), { recursive: true });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('TC-006: retry budget enforced cumulatively across crash and resume', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-retry-budget-'));
    // Ensure the prompt template exists so executePrompt does not hit ENOENT.
    await writeFile(join(FIXTURES_DIR, 'p.md'), 'ping', 'utf8');
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('does not grant additional retries when the attempt budget is already exhausted in persisted state', {
    timeout: 20_000,
  }, async () => {
    const flowPath = join(FIXTURES_DIR, 'retry-budget-flow.ts');
    const flowName = 'retry-budget-flow';
    const flowVersion = '0.1.0';

    // ── Inject state with the budget fully consumed ─────────────────────
    // maxRetries:1 means total budget = 2 attempts.
    // Seeding attempts:2 signals that the budget was exhausted before the
    // crash that triggered this resume.
    const now = new Date().toISOString();
    const injectedState: RunState = {
      runId: 'test-retry-budget-01',
      flowName,
      flowVersion,
      status: 'failed',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        'step-a': {
          status: 'failed',
          attempts: 2,
          startedAt: now,
          completedAt: now,
          errorMessage: 'always fails',
        },
      },
    };

    await writeRunBoilerplate(runDir, flowName, flowVersion, flowPath);
    await atomicWriteJson(join(runDir, 'state.json'), injectedState);

    // ── Resume ───────────────────────────────────────────────────────────
    const provider = new AlwaysFailProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir,
    });

    const result = await orchestrator.resume(runDir, {
      authTimeoutMs: 5_000,
      flowDir: FIXTURES_DIR,
      flagProvider: 'mock',
    });

    // ── Assertions ───────────────────────────────────────────────────────

    // The run must end in 'failed' — the exhausted step can never succeed.
    expect(result.status, 'run must end with status failed').toBe('failed');

    // With priorAttempts=2 and maxRetries=1, remainingRetries=0. withRetry
    // runs the executor exactly once (attempt=0, no retries). A value != 1
    // indicates either the budget clamping regressed or dispatch was skipped.
    expect(
      provider.invokeCount,
      `provider was invoked ${provider.invokeCount} times after budget-exhausted resume; expected exactly 1`,
    ).toBe(1);
  });
});
