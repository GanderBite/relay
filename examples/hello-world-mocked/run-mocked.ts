/**
 * run-mocked.ts — entry point that runs the hello-world-mocked race against
 * a MockProvider with canned responses keyed by runner id. No Claude binary,
 * no subscription, no API key. Useful for CI, smoke tests, and any
 * environment where a real provider is unavailable.
 *
 * The race itself is provider-agnostic — the same `race.ts` runs against
 * ClaudeAgentSdkProvider in production. Swapping in MockProvider happens here,
 * at the Orchestrator's construction site, not inside the race.
 *
 * Invoke:
 *   pnpm --filter hello-world-mocked build
 *   pnpm --filter hello-world-mocked run-mocked
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOrchestrator,
  ProviderRegistry,
  type InvocationResponse,
} from '@relay/core';
import { MockProvider } from '@relay/core/testing';

import race from './race.js';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function cannedResponse(text: string): InvocationResponse {
  return {
    text,
    usage: zeroUsage,
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
    model: 'mock-model',
    stopReason: 'end_turn',
  };
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'World';

  // Canned responses keyed by runner id. The key must match the runner id in
  // race.ts — `greet` and `summarize`. MockProvider throws StepFailureError
  // for any runner id it has no entry for, so both keys are required.
  const greetingSentence = `Welcome to Relay, ${name}. Good to have you here.`;
  const provider = new MockProvider({
    responses: {
      // `greet` has `output: { baton: 'greeting' }` — the text must be the
      // JSON document the baton store expects.
      greet: cannedResponse(JSON.stringify({ greeting: greetingSentence })),
      // `summarize` has `output: { artifact: 'greeting.md' }` — the text is
      // written verbatim to the artifact file.
      summarize: cannedResponse(
        [
          `# Hello, ${name}`,
          '',
          `> ${greetingSentence}`,
          '',
          'This race ran two prompt runners. The first produced a JSON baton named `greeting`; the second turned that baton into this markdown artifact. Both runners ran against a MockProvider with canned responses, so no Claude subprocess was spawned.',
        ].join('\n'),
      ),
    },
  });

  const registry = new ProviderRegistry();
  const registered = registry.register(provider);
  if (registered.isErr()) throw registered.error;

  // This file compiles to dist/run-mocked.js; the prompts live one directory
  // up, in the race package root. Resolve that root so Orchestrator.run() can
  // find `prompts/01_greet.md` and `prompts/02_summarize.md` regardless of
  // where node is invoked from.
  const thisFile = fileURLToPath(import.meta.url);
  const raceDir = resolve(dirname(thisFile), '..');

  const orchestrator = createOrchestrator({ providers: registry });
  const result = await orchestrator.run(race, { name }, { raceDir, flagProvider: 'mock' });

  process.stdout.write(
    [
      `run-mocked: status=${result.status}`,
      `run-mocked: runId=${result.runId}`,
      `run-mocked: runDir=${result.runDir}`,
      `run-mocked: artifacts=${result.artifacts.join(', ')}`,
      `run-mocked: durationMs=${result.durationMs}`,
      '',
    ].join('\n'),
  );

  if (result.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

main().catch((caught) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(`run-mocked failed: ${message}\n`);
  process.exitCode = 1;
});
