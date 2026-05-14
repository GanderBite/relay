import { join } from 'node:path';

import type { Result } from 'neverthrow';

import type { AtomicWriteError } from '../errors.js';
import type { Flow } from '../flow/types.js';
import type { Logger } from '../logger.js';
import type { Provider } from '../providers/types.js';
import { atomicWriteJson } from '../util/atomic-write.js';
import { z } from '../zod.js';

import { writeHandoffHelperScript } from './handoff-helper.js';
import { errorMessageOf } from './run-internal.js';

const FLOW_REF_FILENAME = 'flow-ref.json';

/**
 * Build the per-flow schema map and emit `<runDir>/.bin/handoff.mjs`. The
 * map only includes prompt steps with `output.handoff` AND `output.schema`;
 * artifact-only and handoff-without-schema steps fall through to the legacy
 * stdout-extract path and need no entry. Returns the result so the caller
 * can surface an atomic-write failure as a typed error.
 */
export async function writeHandoffHelper<TInput>(
  runDir: string,
  flow: Flow<TInput>,
): Promise<Result<string, AtomicWriteError>> {
  const schemasById: Record<string, unknown> = {};
  for (const step of Object.values(flow.steps)) {
    if (step.kind === 'prompt') {
      if (!('handoff' in step.output)) continue;
      const schema = step.output.schema;
      if (schema === undefined) continue;
      schemasById[step.output.handoff] = z.toJSONSchema(schema);
      continue;
    }
    // Loop body steps live outside flow.steps, so the prompt-step loop above
    // skips them. Walk each loop's body map so schema-bound prompts inside
    // a loop also land in the helper script.
    if (step.kind === 'loop') {
      for (const bodyStep of Object.values(step.body)) {
        if (bodyStep.kind !== 'prompt') continue;
        if (!('handoff' in bodyStep.output)) continue;
        const schema = bodyStep.output.schema;
        if (schema === undefined) continue;
        schemasById[bodyStep.output.handoff] = z.toJSONSchema(schema);
      }
    }
  }
  return writeHandoffHelperScript({
    runDir,
    schemasById,
    handoffsDir: join(runDir, 'handoffs'),
  });
}

/**
 * Persist the flow-ref.json sidecar so a later resume in a fresh process can
 * locate the flow module. Throws on atomic-write failure — the caller treats
 * this as a fatal pre-walk error.
 *
 * `flowDir` is the absolute path to the flow package root, recorded so resume
 * can restore the original working-directory scope without re-deriving it from
 * `flowPath` (which points at the dist/ entry and is one segment too deep).
 */
export async function writeFlowRef<TInput>(
  runDir: string,
  flow: Flow<TInput>,
  flowPath: string | undefined,
  flowDir: string | undefined,
): Promise<void> {
  const payload = {
    flowName: flow.name,
    flowVersion: flow.version,
    flowPath: flowPath ?? null,
    flowDir: flowDir ?? null,
  };
  const result = await atomicWriteJson(join(runDir, FLOW_REF_FILENAME), payload);
  if (result.isErr()) throw result.error;
}

/**
 * Best-effort `provider.close()` over every provider observed in this run.
 * Errors thrown by close() are caught and logged at warn level — the
 * orchestrator's finally block must not let cleanup errors mask the real
 * failure that triggered teardown.
 */
export async function closeProviders(providers: Iterable<Provider>, logger: Logger): Promise<void> {
  for (const provider of providers) {
    if (provider.close === undefined) continue;
    try {
      await provider.close();
    } catch (caught) {
      logger.warn(
        {
          event: 'provider.close_failed',
          provider: provider.name,
          error: errorMessageOf(caught),
        },
        'provider.close threw during cleanup',
      );
    }
  }
}
