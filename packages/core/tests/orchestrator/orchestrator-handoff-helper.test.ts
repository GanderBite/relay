import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineFlow } from '../../src/flow/define.js';
import { step } from '../../src/flow/step.js';
import { createOrchestrator } from '../../src/orchestrator/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { InvocationResponse } from '../../src/providers/types.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { z } from '../../src/zod.js';

const canned: InvocationResponse = {
  text: '{}',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.001,
  durationMs: 1,
  numTurns: 1,
  model: 'mock',
  stopReason: 'end_turn',
};

describe('Orchestrator emits per-run handoff helper script', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-helper-orch-'));
    await writeFile(join(tmp, 'p.md'), '# prompt body', 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes <runDir>/.bin/handoff.mjs containing only schema-bound handoff entries', async () => {
    const greetedSchema = z.object({ name: z.string() });

    const flow = defineFlow({
      name: 'helper-emit',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        // schema-bound: should appear in the helper.
        greet: step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'greeted', schema: greetedSchema },
        }),
        // handoff without schema: should NOT appear.
        ping: step.prompt({
          promptFile: 'p.md',
          dependsOn: ['greet'],
          output: { handoff: 'pinged' },
        }),
        // artifact-only: should NOT appear.
        report: step.prompt({
          promptFile: 'p.md',
          dependsOn: ['ping'],
          output: { artifact: 'report.html' },
        }),
      },
    });

    const handoffsDir = join(tmp, 'handoffs');
    const provider = new MockProvider({
      responses: {
        greet: async () => {
          await mkdir(handoffsDir, { recursive: true });
          await writeFile(
            join(handoffsDir, 'greeted.json'),
            JSON.stringify({ name: 'alice' }),
            'utf8',
          );
          return { ...canned, text: '{"name":"alice"}' };
        },
        ping: { ...canned, text: '{"k":"v"}' },
        report: { ...canned, text: '<html></html>' },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      flow,
      {},
      { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' },
    );
    expect(result.status).toBe('succeeded');

    const scriptPath = join(tmp, '.bin', 'handoff.mjs');
    const exists = await stat(scriptPath);
    expect(exists.isFile()).toBe(true);

    const source = await readFile(scriptPath, 'utf8');
    // The schema-bound handoff key appears in the embedded SCHEMAS map…
    expect(source).toContain('"greeted"');
    // …while the schemaless handoff and the artifact-only step do not.
    expect(source).not.toContain('"pinged"');
    expect(source).not.toContain('"report.html"');
  });

  it('schema-bound prompt step retries by default when the model misses the handoff on attempt 1', async () => {
    const flow = defineFlow({
      name: 'retry-handoff',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        flaky: step.prompt({
          promptFile: 'p.md',
          // No explicit maxRetries — schema-bound default of 1 is what we test.
          output: { handoff: 'flaky', schema: z.object({ ok: z.boolean() }) },
        }),
      },
    });

    let attempts = 0;
    const handoffsDir = join(tmp, 'handoffs');
    const provider = new MockProvider({
      responses: {
        flaky: async () => {
          attempts += 1;
          if (attempts >= 2) {
            await mkdir(handoffsDir, { recursive: true });
            await writeFile(join(handoffsDir, 'flaky.json'), JSON.stringify({ ok: true }), 'utf8');
          }
          return canned;
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      flow,
      {},
      { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' },
    );

    expect(result.status).toBe('succeeded');
    expect(attempts).toBe(2);
  });

  it('schemaless prompt step does NOT retry by default — first failure aborts', async () => {
    const flow = defineFlow({
      name: 'no-retry-default',
      version: '0.1.0',
      input: z.object({}),
      steps: {
        once: step.prompt({
          promptFile: 'p.md',
          output: { handoff: 'once' },
        }),
      },
    });

    let attempts = 0;
    const provider = new MockProvider({
      responses: {
        once: () => {
          attempts += 1;
          throw new Error('transient');
        },
      },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const orchestrator = createOrchestrator({ providers: registry, runDir: tmp });
    const result = await orchestrator.run(
      flow,
      {},
      { flowDir: tmp, authTimeoutMs: 1_000, flagProvider: 'mock' },
    );

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1);
  });
});
