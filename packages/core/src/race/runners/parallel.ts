import { toRaceDefError } from '../../errors.js';
import { parallelRunnerSpecSchema } from '../schemas.js';
import type { ParallelRunnerSpec } from '../types.js';

/**
 * The shape returned by the parallel builder before the race compiler assigns
 * an id. `defineRace` adds the `id` field from the record key.
 */
export type ParallelRunnerBuilderOutput = Omit<ParallelRunnerSpec, 'id'>;

/**
 * Input shape for the parallel builder. `id` is added by `defineRace` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type ParallelRunnerBuilderInput = Omit<ParallelRunnerSpec, 'id' | 'kind'>;

/**
 * Build a parallel runner spec. Throws `RaceDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function parallelStep(spec: ParallelRunnerBuilderInput): ParallelRunnerBuilderOutput {
  const result = parallelRunnerSpecSchema.safeParse({ id: '_', ...spec, kind: 'parallel' });
  if (!result.success) throw toRaceDefError(result.error, 'invalid parallel runner');

  return {
    ...spec,
    kind: 'parallel',
  };
}
