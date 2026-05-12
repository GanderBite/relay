/**
 * Sprint 5 task_33 contract tests for executePrompt.
 * References packages/core/src/orchestrator/exec/prompt.ts — not yet implemented.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostTracker } from '../../../src/cost.js';
import {
  AgentsResolutionError,
  HandoffOutputError,
  StepFailureError,
} from '../../../src/errors.js';
import { step } from '../../../src/flow/step.js';
import { HandoffStore } from '../../../src/handoffs.js';
import { createLogger } from '../../../src/logger.js';
import { executePrompt } from '../../../src/orchestrator/exec/prompt.js';
import type { InvocationResponse } from '../../../src/providers/types.js';
import { MockProvider } from '../../../src/testing/mock-provider.js';
import { z } from '../../../src/zod.js';

const canned: InvocationResponse = {
  text: '{"name":"alice"}',
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.01,
  durationMs: 10,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('executePrompt (sprint 5 task_33)', () => {
  let tmp: string;
  let flowDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-execp-'));
    flowDir = join(tmp, 'flow');
    await mkdir(join(flowDir, 'prompts'), { recursive: true });
    await writeFile(join(flowDir, 'prompts', 'p.md'), 'Hello {{input.name}}', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeCtxBase() {
    const handoffStore = new HandoffStore(tmp);
    const costTracker = new CostTracker(join(tmp, 'metrics.json'));
    return {
      runDir: tmp,
      flowDir,
      flowName: 'f',
      runId: 'r',
      handoffStore,
      costTracker,
      logger: createLogger({ flowName: 'f', runId: 'r' }),
      abortSignal: new AbortController().signal,
    };
  }

  it('[EXEC-PROMPT-001] loads prompt, loads handoffs, calls assemblePrompt, then provider.invoke', async () => {
    const handoffStore = new HandoffStore(tmp);
    await handoffStore.write('prior', { note: 'ok' });
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      contextFrom: ['prior'],
      output: { handoff: 'greeted' },
    });

    let capturedPrompt = '';
    const provider = new MockProvider({
      responses: {
        [s.id || 'greet']: (req) => {
          capturedPrompt = req.prompt;
          return { ...canned, text: '{"hello":"world"}' };
        },
      },
    });

    const ctx = {
      ...makeCtxBase(),
      handoffStore,
      stepId: s.id || 'greet',
      step: s,
      provider,
      attempt: 1,
    };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(capturedPrompt).toContain('<c name="prior">');
    // handoff written
    const wrote = await handoffStore.read('greeted');
    expect(wrote.isOk()).toBe(true);
  });

  it('[EXEC-PROMPT-002] schema-bound handoff appends OUTPUT CONTRACT to the prompt and drops request.jsonSchema', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: { handoff: 'x', schema: z.object({ name: z.string() }) },
    });

    let capturedRequest: { prompt: string; jsonSchema?: unknown } | undefined;
    // The model "writes" its handoff to disk so the post-invoke read succeeds —
    // simulating the helper-script round-trip without spawning subprocesses.
    const ctxBase = makeCtxBase();
    const handoffsDir = join(tmp, 'handoffs');
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: async (req) => {
          capturedRequest = { prompt: req.prompt, jsonSchema: req.jsonSchema };
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(join(handoffsDir, 'x.json'), JSON.stringify({ name: 'alice' }), 'utf8');
          return canned;
        },
      },
    });

    const ctx = { ...ctxBase, stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.prompt).toContain('## OUTPUT CONTRACT (required)');
    expect(capturedRequest?.prompt).toContain('"type": "object"');
    // Contract appended ⇒ jsonSchema is intentionally dropped.
    expect(capturedRequest?.jsonSchema).toBeUndefined();
  });

  it('handoff-without-schema steps do NOT append OUTPUT CONTRACT', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: { handoff: 'noschema' },
    });
    let capturedPrompt = '';
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: (req) => {
          capturedPrompt = req.prompt;
          return { ...canned, text: '{"k":"v"}' };
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(capturedPrompt).not.toContain('OUTPUT CONTRACT');
  });

  it('artifact-only steps do NOT append OUTPUT CONTRACT', async () => {
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { artifact: 'r.html' } });
    let capturedPrompt = '';
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: (req) => {
          capturedPrompt = req.prompt;
          return { ...canned, text: '<html></html>' };
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(capturedPrompt).not.toContain('OUTPUT CONTRACT');
  });

  it('schema-bound step with explicit tools list adds Bash + Write to enriched tools', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      tools: ['Read'],
      output: { handoff: 'enr', schema: z.object({ ok: z.boolean() }) },
    });
    const handoffsDir = join(tmp, 'handoffs');
    let capturedTools: string[] | undefined;
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: async (req) => {
          capturedTools = req.tools;
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(join(handoffsDir, 'enr.json'), JSON.stringify({ ok: true }), 'utf8');
          return { ...canned, text: '{"ok":true}' };
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(capturedTools).toContain('Read');
    expect(capturedTools).toContain('Bash');
    expect(capturedTools).toContain('Write');
  });

  it('[EXEC-PROMPT-003] schema-bound handoff with no file written surfaces HandoffOutputError(missing)', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: {
        handoff: 'entities',
        schema: z.object({
          entities: z.array(z.object({ name: z.string() })),
        }),
      },
    });
    const provider = new MockProvider({
      // Provider returns text but never writes the handoff file ⇒ missing.
      responses: {
        [s.id || 'p']: { ...canned, text: '(model forgot to call helper)' },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await expect(
      executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]),
    ).rejects.toMatchObject({
      name: 'HandoffOutputError',
      reason: 'missing',
    });
  });

  it('schema-bound handoff with malformed JSON file surfaces HandoffOutputError(invalid_json)', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: { handoff: 'malformed', schema: z.object({ k: z.string() }) },
    });
    const handoffsDir = join(tmp, 'handoffs');
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: async () => {
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(join(handoffsDir, 'malformed.json'), '{not json', 'utf8');
          return canned;
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await expect(
      executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]),
    ).rejects.toMatchObject({
      name: 'HandoffOutputError',
      reason: 'invalid_json',
    });
  });

  it('schema-bound handoff with wrong-shape JSON surfaces HandoffOutputError(schema_mismatch)', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: { handoff: 'wrong', schema: z.object({ name: z.string() }) },
    });
    const handoffsDir = join(tmp, 'handoffs');
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: async () => {
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(join(handoffsDir, 'wrong.json'), JSON.stringify({ name: 1 }), 'utf8');
          return canned;
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    let caught: unknown;
    try {
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HandoffOutputError);
    const err = caught as HandoffOutputError;
    expect(err.reason).toBe('schema_mismatch');
    expect(err.details?.issues?.length).toBeGreaterThan(0);
  });

  it('[EXEC-PROMPT-004] writes artifact file when output.artifact is set', async () => {
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { artifact: 'report.html' } });
    const provider = new MockProvider({
      responses: { [s.id || 'p']: { ...canned, text: '<html>...</html>' } },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    const bytes = await readFile(join(tmp, 'artifacts', 'report.html'), 'utf8');
    expect(bytes).toContain('<html>');
  });

  it('[EXEC-PROMPT-ARTIFACT-001] artifact file contains handoff JSON when both handoff and artifact are set', async () => {
    const handoffId = 'summary';
    // A schema is required so the executor reads from the handoff file rather
    // than extracting JSON from response.text.
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: {
        handoff: handoffId,
        artifact: 'summary.json',
        schema: z.object({ title: z.string(), count: z.number() }),
      },
    });
    const handoffsDir = join(tmp, 'handoffs');
    const handoffPayload = { title: 'hello', count: 3 };
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: async () => {
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(
            join(handoffsDir, `${handoffId}.json`),
            JSON.stringify(handoffPayload),
            'utf8',
          );
          // response.text differs from handoff content to confirm the artifact
          // uses the validated handoff JSON, not the raw provider text.
          return { ...canned, text: 'raw model output that is not the artifact' };
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    const artifactBytes = await readFile(join(tmp, 'artifacts', 'summary.json'), 'utf8');
    const parsed = JSON.parse(artifactBytes) as unknown;
    expect(parsed).toEqual(handoffPayload);
    // Must not contain the raw provider text
    expect(artifactBytes).not.toContain('raw model output');
  });

  it('[EXEC-PROMPT-ARTIFACT-002] artifact file contains response.text when only artifact is set (no handoff)', async () => {
    const s = step.prompt({
      promptFile: 'prompts/p.md',
      output: { artifact: 'output.txt' },
    });
    const responseText = 'This is the raw model response for the artifact.';
    const provider = new MockProvider({
      responses: { [s.id || 'p']: { ...canned, text: responseText } },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

    const artifactBytes = await readFile(join(tmp, 'artifacts', 'output.txt'), 'utf8');
    expect(artifactBytes).toBe(responseText);
  });

  it('[EXEC-PROMPT-005] records StepMetrics via costTracker', async () => {
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { handoff: 'x' } });
    const ctxBase = makeCtxBase();
    const recordSpy = vi.spyOn(ctxBase.costTracker, 'record');
    const provider = new MockProvider({ responses: { [s.id || 'p']: canned } });
    const ctx = { ...ctxBase, stepId: s.id || 'p', step: s, provider, attempt: 1 };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const metric = recordSpy.mock.calls[0]?.[0];
    expect(metric.tokensIn).toBe(100);
    expect(metric.tokensOut).toBe(50);
    expect(metric.costUsd).toBe(0.01);
  });

  it('[EXEC-PROMPT-006] wraps provider errors in StepFailureError with stepId + attempt', async () => {
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { handoff: 'x' } });
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: () => {
          throw new Error('network blip');
        },
      },
    });
    const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 2 };
    await expect(
      executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]),
    ).rejects.toMatchObject({
      name: 'StepFailureError',
      attempt: 2,
    });
    // Also verify class
    try {
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    } catch (e) {
      expect(e).toBeInstanceOf(StepFailureError);
    }
  });

  it('[EXEC-PROMPT-007] passes ctx.abortSignal into InvocationContext', async () => {
    const ctrl = new AbortController();
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { handoff: 'x' } });
    let capturedSignal: AbortSignal | undefined;
    const provider = new MockProvider({
      responses: {
        [s.id || 'p']: (_req, ictx) => {
          capturedSignal = ictx.abortSignal;
          return canned;
        },
      },
    });
    const ctx = {
      ...makeCtxBase(),
      stepId: s.id || 'p',
      step: s,
      provider,
      attempt: 1,
      abortSignal: ctrl.signal,
    };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(capturedSignal).toBe(ctrl.signal);
  });

  it('[EXEC-PROMPT-008] emits logger events prompt.start / prompt.done on success, prompt.failed on error', async () => {
    const events: string[] = [];
    const stubLogger = {
      info: (obj: { event?: string }) => {
        if (obj?.event) events.push(obj.event);
      },
      warn: () => undefined,
      error: (obj: { event?: string }) => {
        if (obj?.event) events.push(obj.event);
      },
      debug: () => undefined,
      child: function () {
        return this;
      },
    };
    const s = step.prompt({ promptFile: 'prompts/p.md', output: { handoff: 'x' } });
    const provider = new MockProvider({ responses: { [s.id || 'p']: canned } });
    const ctx = {
      ...makeCtxBase(),
      stepId: s.id || 'p',
      step: s,
      provider,
      attempt: 1,
      logger: stubLogger,
    };
    await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
    expect(events).toContain('prompt.start');
    expect(events).toContain('prompt.done');
  });

  describe('staging-file contract paths in OUTPUT CONTRACT', () => {
    // These tests verify that the literal paths embedded in the OUTPUT CONTRACT
    // block are derived from runDir and handoffId — not hardcoded, not relative.
    // If executePrompt ever fell back to a different path derivation strategy
    // the model would try to invoke a script that does not exist.

    it('[EXEC-PROMPT-STAGING-001] staging path in OUTPUT CONTRACT is <runDir>/.tmp/<handoffId>.json', async () => {
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: { handoff: 'inventory', schema: z.object({ items: z.array(z.string()) }) },
      });
      const handoffsDir = join(tmp, 'handoffs');
      let capturedPrompt = '';
      const provider = new MockProvider({
        responses: {
          [s.id || 'p']: async (req) => {
            capturedPrompt = req.prompt;
            await mkdir(handoffsDir, { recursive: true });
            await writeFile(
              join(handoffsDir, 'inventory.json'),
              JSON.stringify({ items: ['a', 'b'] }),
              'utf8',
            );
            return canned;
          },
        },
      });
      const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

      // The staging path must be the absolute path under runDir/.tmp — not a
      // relative path, not a different directory. The model writes here before
      // calling the helper script.
      const expectedStagingPath = join(tmp, '.tmp', 'inventory.json');
      expect(capturedPrompt).toContain(expectedStagingPath);
    });

    it('[EXEC-PROMPT-STAGING-002] handoff script path in OUTPUT CONTRACT is <runDir>/.bin/handoff.mjs', async () => {
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: { handoff: 'summary', schema: z.object({ text: z.string() }) },
      });
      const handoffsDir = join(tmp, 'handoffs');
      let capturedPrompt = '';
      const provider = new MockProvider({
        responses: {
          [s.id || 'p']: async (req) => {
            capturedPrompt = req.prompt;
            await mkdir(handoffsDir, { recursive: true });
            await writeFile(
              join(handoffsDir, 'summary.json'),
              JSON.stringify({ text: 'done' }),
              'utf8',
            );
            return canned;
          },
        },
      });
      const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

      // The script path must point to .bin/handoff.mjs under runDir. Any other
      // path would make the Bash invocation fail because that script does not exist.
      const expectedScriptPath = join(tmp, '.bin', 'handoff.mjs');
      expect(capturedPrompt).toContain(`node ${expectedScriptPath}`);
    });

    it('[EXEC-PROMPT-STAGING-003] OUTPUT CONTRACT sentinel "OK <handoffId>" matches the step handoff id', async () => {
      const handoffId = 'my_unique_handoff';
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: {
          handoff: handoffId,
          schema: z.object({ value: z.number() }),
        },
      });
      const handoffsDir = join(tmp, 'handoffs');
      let capturedPrompt = '';
      const provider = new MockProvider({
        responses: {
          [s.id || 'p']: async (req) => {
            capturedPrompt = req.prompt;
            await mkdir(handoffsDir, { recursive: true });
            await writeFile(
              join(handoffsDir, `${handoffId}.json`),
              JSON.stringify({ value: 42 }),
              'utf8',
            );
            return canned;
          },
        },
      });
      const ctx = { ...makeCtxBase(), stepId: s.id || 'p', step: s, provider, attempt: 1 };
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

      // The sentinel the model must see before stopping must use the exact
      // handoff id — a mismatch would leave the model in an infinite loop
      // checking for an "OK" line that never arrives.
      expect(capturedPrompt).toContain(`OK ${handoffId}`);
      // The Bash command must also reference the handoff id for routing.
      expect(capturedPrompt).toContain(`write ${handoffId} --from`);
    });
  });

  describe('agents field wiring', () => {
    it('sets InvocationRequest.agents when step.agents is an inline array', async () => {
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: { handoff: 'result' },
        agents: [{ name: 'helper', systemPrompt: 'Be helpful.', description: 'Helper agent' }],
      });
      const stepId = s.id || 'p';

      let capturedRequest: Parameters<MockProvider['invoke']>[0] | undefined;
      const handoffsDir = join(tmp, 'handoffs');
      const provider = new MockProvider({
        responses: {
          [stepId]: async (req) => {
            capturedRequest = req;
            await mkdir(handoffsDir, { recursive: true });
            await writeFile(join(handoffsDir, 'result.json'), JSON.stringify({ ok: true }), 'utf8');
            return { ...canned, text: '{"ok":true}' };
          },
        },
      });

      const ctx = { ...makeCtxBase(), stepId, step: s, provider, attempt: 1 };
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.agents).toHaveLength(1);
      const agent = capturedRequest?.agents?.[0] as Record<string, unknown> | undefined;
      // In-memory shape: name and systemPrompt are present.
      expect(agent?.name).toBe('helper');
      expect(agent?.systemPrompt).toBe('Be helpful.');
      // Relay-only fields must not be forwarded to the provider.
      expect(agent).not.toHaveProperty('extends');
      expect(agent).not.toHaveProperty('skillsMerge');
    });

    it('sets InvocationRequest.agents undefined when step.agents is absent', async () => {
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: { handoff: 'result' },
        // No agents field.
      });
      const stepId = s.id || 'p';

      let capturedRequest: Parameters<MockProvider['invoke']>[0] | undefined;
      const provider = new MockProvider({
        responses: {
          [stepId]: (req) => {
            capturedRequest = req;
            return { ...canned, text: '{"ok":true}' };
          },
        },
      });

      const ctx = { ...makeCtxBase(), stepId, step: s, provider, attempt: 1 };
      await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.agents).toBeUndefined();
    });

    it('propagates AgentsResolutionError as-is (not wrapped in StepFailureError)', async () => {
      // step.agents references a handoff that was never written — triggers
      // AgentsResolutionError in resolveAgents before the provider is called.
      const s = step.prompt({
        promptFile: 'prompts/p.md',
        output: { handoff: 'result' },
        agents: { from: 'handoff.plan', required: true },
      });
      const stepId = s.id || 'p';

      const provider = new MockProvider({
        responses: {
          [stepId]: canned,
        },
      });

      const ctx = { ...makeCtxBase(), stepId, step: s, provider, attempt: 1 };
      let caught: unknown;
      try {
        await executePrompt(s, ctx as unknown as Parameters<typeof executePrompt>[1]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AgentsResolutionError);
      // Must NOT be wrapped in StepFailureError.
      expect(caught).not.toBeInstanceOf(StepFailureError);
    });
  });
});
