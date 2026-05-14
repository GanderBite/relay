/**
 * Regression tests: RELAY_FLOW_DIR must be identical in script steps that
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
 *
 * Three scenarios are covered:
 *
 * 1. Primary: resume with no opts.flowDir — the value must come from
 *    flowRef.flowDir persisted by the initial run().  Exercises the second
 *    branch of the resolution chain:
 *      opts.flowDir ?? flowRef.flowDir ?? backCompatFlowDir(flowRef.flowPath)
 *
 * 2. Back-compat: flow-ref.json was written before the flowDir field was
 *    introduced (i.e. flowDir is absent).  Resume must still resolve correctly
 *    by falling through to backCompatFlowDir(flowRef.flowPath).  The synthetic
 *    flowPath is set to <tmp>/dist/flow.js so that backCompatFlowDir strips the
 *    /dist segment and returns <tmp>.
 *
 * 3. Smoke: first pass pauses without invoking any provider.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Absolute path to the built core dist index so the synthetic back-compat flow
// module can import defineFlow/step/z without relying on package-name
// resolution (which is unavailable from an arbitrary temp directory).
const CORE_DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');

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

/** Write the answer handoff so the paused ask step can be satisfied on resume. */
async function writeAnswer(runDir: string, stepId: string): Promise<void> {
  const answerPath = askAnswerHandoffPath(runDir, stepId);
  await mkdir(join(runDir, 'handoffs'), { recursive: true });
  const result = await atomicWriteJson(answerPath, { confirm: 'yes' });
  expect(result.isOk()).toBe(true);
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

  it('RELAY_FLOW_DIR is identical in script steps before and after resume (flowRef.flowDir branch)', async () => {
    // This test exercises the second branch of the resolution chain:
    //   opts.flowDir ?? flowRef.flowDir ?? backCompatFlowDir(flowRef.flowPath)
    // By NOT passing opts.flowDir to resume(), we force the orchestrator to
    // read flowDir from the persisted flow-ref.json.  If the fix were reverted
    // (i.e. resume always used opts.flowDir), the absence of opts.flowDir would
    // cause flowDir to fall back to undefined or process.cwd(), breaking the
    // assertion below.
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

    // Satisfy the ask step so resume can proceed.
    await writeAnswer(tmp, 'pause-ask');

    // Resume WITHOUT supplying opts.flowDir — the orchestrator must restore it
    // from flowRef.flowDir that run() persisted into flow-ref.json.
    const resumeResult = await orchestrator.resume(tmp, {
      authTimeoutMs: 1_000,
      flagProvider: 'mock',
      worktree: false,
    });

    expect(resumeResult.status).toBe('succeeded');

    // Read the flowdir recorded by script-after.
    const flowdirAfter = (await readFile(join(tmp, 'flowdir-after.txt'), 'utf8')).trim();
    expect(flowdirAfter).toBeTruthy();

    // The core invariant: flowDir must be the same before and after resume.
    expect(flowdirBefore).toBe(flowdirAfter);

    // Both values must equal the tmp dir that was originally passed as flowDir.
    expect(flowdirBefore).toBe(tmp);
  });

  it('resumes via backCompatFlowDir when flow-ref.json predates the flowDir field', async () => {
    // This test exercises the third branch of the resolution chain:
    //   opts.flowDir ?? flowRef.flowDir ?? backCompatFlowDir(flowRef.flowPath)
    // After the initial run() we mutate flow-ref.json to remove the flowDir
    // field and replace flowPath with a synthetic path under <tmp>/dist/ so
    // that backCompatFlowDir strips the /dist segment and returns <tmp>.
    // If the fix were reverted, the absent flowDir field and the absence of
    // opts.flowDir would cause an undefined cwd, breaking script-after.

    const orchestrator = createOrchestrator({
      providers: makeRegistry(),
      runDir: tmp,
    });

    // First pass: run until the ask step pauses.
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

    // Read the flowdir recorded by script-before so we can assert continuity.
    const flowdirBefore = (await readFile(join(tmp, 'flowdir-before.txt'), 'utf8')).trim();
    expect(flowdirBefore).toBe(tmp);

    // Build a synthetic dist/flow.js module at <tmp>/dist/flow.js.
    // The module imports from the built core dist (absolute path) and re-exports
    // the same flow definition, so importFlow() can re-construct the flow object
    // without relying on package-name resolution from the temp directory.
    const distDir = join(tmp, 'dist');
    await mkdir(distDir, { recursive: true });
    const syntheticFlowPath = join(distDir, 'flow.js');
    const syntheticFlowSource = [
      '// Synthetic back-compat flow module written by resume-cwd.test.ts.',
      `import { defineFlow, step, z } from '${CORE_DIST_INDEX}';`,
      'export const flow = defineFlow({',
      "  name: 'script-ask-script',",
      "  version: '0.0.1',",
      '  input: z.object({}),',
      '  steps: {',
      "    'script-before': step.script({",
      '      run: [\'sh\', \'-c\', \'printf "%s" "$RELAY_FLOW_DIR" > "$RELAY_RUN_DIR/flowdir-before.txt"\'],',
      '    }),',
      "    'pause-ask': step.ask({",
      "      questions: [{ id: 'confirm', kind: 'text', label: 'Ready to continue?' }],",
      "      dependsOn: ['script-before'],",
      '    }),',
      "    'script-after': step.script({",
      '      run: [\'sh\', \'-c\', \'printf "%s" "$RELAY_FLOW_DIR" > "$RELAY_RUN_DIR/flowdir-after.txt"\'],',
      "      dependsOn: ['pause-ask'],",
      '    }),',
      '  },',
      '});',
      'export default flow;',
    ].join('\n');
    await writeFile(syntheticFlowPath, syntheticFlowSource, 'utf8');

    // Rewrite flow-ref.json: remove flowDir (simulating a legacy record) and
    // set flowPath to the synthetic dist path so backCompatFlowDir can strip
    // /dist and return <tmp>.
    const refPath = join(tmp, 'flow-ref.json');
    const refRaw = JSON.parse(await readFile(refPath, 'utf8')) as Record<string, unknown>;
    delete refRaw['flowDir'];
    refRaw['flowPath'] = syntheticFlowPath;
    const patchResult = await atomicWriteJson(refPath, refRaw);
    expect(patchResult.isOk()).toBe(true);

    // Satisfy the ask step.
    await writeAnswer(tmp, 'pause-ask');

    // Resume with NO opts.flowDir and NO opts.flowPath — backCompatFlowDir
    // must derive the package root from the /dist segment of flowPath.
    const resumeResult = await orchestrator.resume(tmp, {
      authTimeoutMs: 1_000,
      flagProvider: 'mock',
      worktree: false,
    });

    expect(resumeResult.status).toBe('succeeded');

    // script-after records what RELAY_FLOW_DIR was at resume time.
    const flowdirAfter = (await readFile(join(tmp, 'flowdir-after.txt'), 'utf8')).trim();
    expect(flowdirAfter).toBeTruthy();

    // backCompatFlowDir('<tmp>/dist/flow.js') must strip /dist and return <tmp>.
    expect(flowdirAfter).toBe(tmp);
    // Continuity: both script steps saw the same dir.
    expect(flowdirBefore).toBe(flowdirAfter);
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
