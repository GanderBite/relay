/**
 * Child-process harness for the crash-resume integration test.
 *
 * Run by the parent test via child_process.fork with --experimental-strip-types.
 * Receives the run directory as the first command-line argument.
 *
 * Behavior:
 *   - Runner "a": completes immediately with a valid JSON baton response.
 *   - Runner "b": sends process.send({ type: 'live-state-observed' }) to the
 *     parent once its stream() is invoked (which happens after the live-state
 *     file for "b" is written to disk), then hangs forever. The parent SIGKILL
 *     terminates the process before the stream resolves.
 *
 * The orchestrator writes race-ref.json pointing to crash-test-race.ts so
 * that Orchestrator.resume() in the parent can re-import the race.
 */
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, type Result } from 'neverthrow';
import { createOrchestrator, ProviderRegistry } from '@relay/core';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '@relay/core';
import type { PipelineError } from '@relay/core';
import { race } from './crash-test-race.ts';

const runDir = process.argv[2];
if (typeof runDir !== 'string' || runDir.length === 0) {
  process.stderr.write('child-runner: missing runDir argument\n');
  process.exit(1);
}

const hereDir = dirname(fileURLToPath(import.meta.url));
const racePath = join(hereDir, 'crash-test-race.ts');

const ZERO_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const STEP_A_RESPONSE: InvocationResponse = {
  text: '{"ok":true}',
  usage: ZERO_USAGE,
  costUsd: 0,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const capabilities: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['mock'],
  maxContextTokens: 200_000,
};

let ipCSent = false;

const provider: Provider = {
  name: 'mock',
  capabilities,

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'child harness mock' });
  },

  async invoke(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    if (ctx.runnerId === 'a') {
      return ok(STEP_A_RESPONSE);
    }
    // Runner "b": signal parent, then hang forever.
    if (!ipCSent) {
      ipCSent = true;
      if (typeof process.send === 'function') {
        process.send({ type: 'live-state-observed' });
      }
    }
    return new Promise<Result<InvocationResponse, PipelineError>>(() => {
      // intentionally never resolves — parent will SIGKILL before this returns
    });
  },

  async *stream(
    _req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<InvocationEvent> {
    if (ctx.runnerId === 'a') {
      yield { type: 'turn.start', turn: 1 };
      yield { type: 'text.delta', delta: '{"ok":true}' };
      yield { type: 'usage', usage: ZERO_USAGE };
      yield { type: 'turn.end', turn: 1 };
      return;
    }
    // Runner "b": signal parent, then hang forever inside the async generator.
    if (!ipCSent) {
      ipCSent = true;
      if (typeof process.send === 'function') {
        process.send({ type: 'live-state-observed' });
      }
    }
    await new Promise<void>(() => {
      // intentionally never resolves — parent will SIGKILL before this yields
    });
  },
};

const registry = new ProviderRegistry();
registry.register(provider);

// The prompt executor reads promptFile relative to raceDir. Write a minimal
// template so the executor does not trip on ENOENT during both steps.
await writeFile(join(hereDir, 'p.md'), 'ping', 'utf8');

const orchestrator = createOrchestrator({
  providers: registry,
  runDir,
});

try {
  await orchestrator.run(race, {}, {
    racePath,
    raceDir: hereDir,
    authTimeoutMs: 5_000,
    flagProvider: 'mock',
  });
} catch {
  // run() may throw if the process is still alive when the race fails;
  // the parent SIGKILLs this process before that happens in normal test race.
  process.exit(1);
}
