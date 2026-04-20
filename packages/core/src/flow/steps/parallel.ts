import { toFlowDefError } from '../../errors.js';
import { parallelStepSpecSchema } from '../schemas.js';
import type { ParallelStepSpec } from '../types.js';

/**
 * The shape returned by the parallel builder before the flow compiler assigns
 * an id. `defineFlow` adds the `id` field from the record key.
 */
export type ParallelStepBuilderOutput = Omit<ParallelStepSpec, 'id'>;

/**
 * Input shape for the parallel builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type ParallelStepBuilderInput = Omit<ParallelStepSpec, 'id' | 'kind'>;

/**
 * Build a parallel step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function parallelStep(spec: ParallelStepBuilderInput): ParallelStepBuilderOutput {
  const result = parallelStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'parallel' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid parallel step');

  return {
    ...spec,
    kind: 'parallel',
  };
}
