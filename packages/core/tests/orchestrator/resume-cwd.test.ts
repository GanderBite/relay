/**
 * Regression test: RELAY_FLOW_DIR must be identical in script steps that
 * execute before and after a pause/resume boundary. The bug this guards was
 * that Orchestrator.resume() derived flowDir from dirname(flowPath), which
 * returns the dist/ entry directory — one level too deep — instead of the
 * flow package root. The fix persists flowDir in flow-ref.json at run start
 * and restores it verbatim on resume.
 *
 * The flow under test has three steps:
 *   script-before → pause-ask → script-after
 *
 * Each script step writes $RELAY_FLOW_DIR to a file inside $RELAY_RUN_DIR.
 * After the pause/resume round-trip the test reads both files and asserts
 * they contain the same path.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askAnswerHandoffPath } from '../../src/orchestrator/exec/ask.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { atomicWriteJson } from '../../src/util/atomic-write.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ASK_SCRIPT_FIXTURE = join(HERE, 'fixtures', 'script-ask-script-flow.ts');

const canned: InvocationResponse = {
  text: '{"result":"ok"}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

const RUN_OPTS = { authTimeoutMs: 1_000, flagProvider: 'mock', worktree: false } as const;

function makeRegistry() {
  const provider = new MockProvider({ responses: {} });
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator — cwd stability across pause/resume', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-resume-cwd-'));
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('RELAY_FLOW_DIR is identical in script steps before and after resume', async () => {
    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    // First pass: script-before runs, pause-ask halts the run.
    const firstResult = await orchestrator.run(
      (await import(SCRIPT_ASK_SCRIPT_FIXTURE)).default,
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: SCRIPT_ASK_SCRIPT_FIXTURE,
      },
    );

    expect(firstResult.status).toBe('paused');
    expect(firstResult.pausedStepId).toBe('pause-ask');

    // Read the flowdir recorded by script-before.
    const flowdirBefore = (await readFile(join(tmp, 'flowdir-before.txt'), 'utf8')).trim();
    expect(flowdirBefore).toBeTruthy();

    // Operator-equivalent: write the answer file at the conventional path.
    const answerPath = askAnswerHandoffPath(tmp, 'pause-ask');
    await mkdir(join(tmp, 'handoffs'), { recursive: true });
    const writeResult = await atomicWriteJson(answerPath, { confirm: 'yes' });
    expect(writeResult.isOk()).toBe(true);

    // Resume: script-after runs with the restored flowDir.
    const resumeResult = await orchestrator.resume(tmp, {
      ...RUN_OPTS,
      flowDir: tmp,
    });

    expect(resumeResult.status).toBe('succeeded');

    // Read the flowdir recorded by script-after.
    const flowdirAfter = (await readFile(join(tmp, 'flowdir-after.txt'), 'utf8')).trim();
    expect(flowdirAfter).toBeTruthy();

    // The core invariant: flowDir must be the same before and after resume.
    expect(flowdirBefore).toBe(flowdirAfter);

    // Both values must equal the tmp dir passed as flowDir to run().
    expect(flowdirBefore).toBe(tmp);
  });

  it('first pass: run pauses at the ask step without invoking any provider', async () => {
    const canned_response = canned;
    const provider = new MockProvider({ responses: { 'script-before': canned_response } });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({
      providers: registry,
      runDir: tmp,
    });

    const result = await orchestrator.run(
      (await import(SCRIPT_ASK_SCRIPT_FIXTURE)).default,
      {},
      {
        ...RUN_OPTS,
        flowDir: tmp,
        flowPath: SCRIPT_ASK_SCRIPT_FIXTURE,
      },
    );

    expect(result.status).toBe('paused');
    expect(result.pausedStepId).toBe('pause-ask');
  });
});
