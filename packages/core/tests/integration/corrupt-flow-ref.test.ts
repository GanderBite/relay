/**
 * Integration tests for corrupt / missing flow-ref.json on resume.
 *
 * Covers three failure modes in loadFlowRef / importFlow:
 *   1. flow-ref.json contains invalid JSON  → StateCorruptError wrapped in PipelineError
 *   2. flow-ref.json points to a non-existent dist/flow.js → FlowImportError (reason: 'absent')
 *   3. Positive path: valid flow-ref.json pointing to a real fixture flow → resume returns succeeded result
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ok, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipelineError } from '../../src/errors.js';
import { ERROR_CODES, FlowImportError } from '../../src/errors.js';
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

// ── shared types ──────────────────────────────────────────────────────────────

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
 * Provider that fails loudly if invoke() is called. Used to guard that no step
 * execution occurs before the expected error is thrown during resume.
 */
class GuardProvider implements Provider {
  readonly name = 'mock';
  readonly capabilities = DEFAULT_CAPS;

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'guard mock' });
  }

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    throw new Error(`invoke must not be called — got stepId "${ctx.stepId}"`);
  }

  stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<import('../../src/providers/types.js').InvocationEvent> {
    throw new Error(`stream must not be called — got stepId "${ctx.stepId}"`);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return {
    runId: 'test-corrupt-flow-ref',
    flowName: 'crash-test-flow',
    flowVersion: '0.1.0',
    status: 'failed',
    startedAt: now,
    updatedAt: now,
    input: {},
    steps: {
      a: { status: 'failed', attempts: 1, startedAt: now, completedAt: now },
    },
    ...overrides,
  };
}

async function writeRunBoilerplate(runDir: string, flowRef: unknown): Promise<void> {
  await writeFile(
    join(runDir, 'flow-ref.json'),
    typeof flowRef === 'string' ? flowRef : JSON.stringify(flowRef),
    'utf8',
  );
  await atomicWriteJson(join(runDir, 'metrics.json'), []);
  await mkdir(join(runDir, 'live'), { recursive: true });
}

function makeOrchestrator(runDir: string) {
  const provider = new GuardProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);
  return createOrchestrator({ providers: registry, runDir });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('resume with corrupt or missing flow-ref.json', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'relay-corrupt-flow-ref-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('corrupt flow-ref.json produces a typed error', { timeout: 15_000 }, async () => {
    // Write deliberately invalid JSON to flow-ref.json.
    // loadFlowRef() returns StateCorruptError; the Orchestrator wraps it in a
    // PipelineError with code STATE_NOT_FOUND before throwing.
    const state = makeState();
    await mkdir(runDir, { recursive: true });
    await writeRunBoilerplate(runDir, '{not valid json:::');
    await atomicWriteJson(join(runDir, 'state.json'), state);

    const orchestrator = makeOrchestrator(runDir);

    let thrown: unknown;
    try {
      await orchestrator.resume(runDir, {
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      });
    } catch (e) {
      thrown = e;
    }

    // The orchestrator wraps the StateCorruptError from loadFlowRef into a
    // PipelineError. The error code must be STATE_NOT_FOUND because the
    // orchestrator cannot locate a valid flow-ref to resume from.
    expect(thrown, 'resume must throw when flow-ref.json is corrupt').toBeDefined();
    const err = thrown as { code?: string; message?: string };
    expect(err.code).toBe(ERROR_CODES.STATE_NOT_FOUND);
    expect(err.message).toMatch(/flow-ref\.json/);
  });

  it('flow-ref.json pointing to missing dist/flow.js produces FlowImportError', {
    timeout: 15_000,
  }, async () => {
    // Valid flow-ref.json structure, but flowPath points to a file that does
    // not exist on disk. importFlow() must throw FlowImportError with reason
    // 'absent' (the discriminant emitted by the import catch branch in resume.ts).
    const nonExistentPath = join(runDir, 'does-not-exist', 'dist', 'flow.js');
    const state = makeState();
    await mkdir(runDir, { recursive: true });
    await writeRunBoilerplate(runDir, {
      flowName: 'crash-test-flow',
      flowVersion: '0.1.0',
      flowPath: nonExistentPath,
    });
    await atomicWriteJson(join(runDir, 'state.json'), state);

    const orchestrator = makeOrchestrator(runDir);

    let thrown: unknown;
    try {
      await orchestrator.resume(runDir, {
        authTimeoutMs: 5_000,
        flagProvider: 'mock',
        worktree: false,
      });
    } catch (e) {
      thrown = e;
    }

    // importFlow throws FlowImportError when the module file is absent.
    // The reason discriminant is 'absent' (not 'missing-file') — see importFlow
    // in packages/core/src/orchestrator/resume.ts.
    expect(thrown, 'resume must throw when the flow module file is missing').toBeDefined();
    expect(thrown).toBeInstanceOf(FlowImportError);
    const importErr = thrown as FlowImportError;
    expect(importErr.code).toBe(ERROR_CODES.FLOW_IMPORT);
    expect(importErr.details?.reason).toBe('absent');
    expect(importErr.details?.path).toBe(nonExistentPath);
  });

  it('valid flow-ref.json pointing to existing fixture succeeds', { timeout: 15_000 }, async () => {
    // Positive case: persist an already-succeeded run state. The orchestrator
    // short-circuits resume() and returns a rebuilt RunResult without invoking
    // any provider step, so no MockProvider responses are needed.
    const now = new Date().toISOString();
    const succeededState: RunState = {
      runId: 'test-corrupt-flow-ref-ok',
      flowName: 'crash-test-flow',
      flowVersion: '0.1.0',
      status: 'succeeded',
      startedAt: now,
      updatedAt: now,
      input: {},
      steps: {
        a: { status: 'succeeded', attempts: 1, startedAt: now, completedAt: now },
        b: { status: 'succeeded', attempts: 1, startedAt: now, completedAt: now },
      },
    };

    const flowPath = join(FIXTURES_DIR, 'crash-test-flow.ts');
    await mkdir(runDir, { recursive: true });
    await writeRunBoilerplate(runDir, {
      flowName: 'crash-test-flow',
      flowVersion: '0.1.0',
      flowPath,
    });
    await atomicWriteJson(join(runDir, 'state.json'), succeededState);

    const orchestrator = makeOrchestrator(runDir);

    const result = await orchestrator.resume(runDir, {
      authTimeoutMs: 5_000,
      flagProvider: 'mock',
      worktree: false,
    });

    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe('test-corrupt-flow-ref-ok');
  });
});
