import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { parallelStepSpecSchema } from '../schemas.js';
import type { ParallelStepSpec } from '../types.js';

/**
 * The shape returned by the parallel builder before the flow compiler assigns
 * an id. `defineFlow` adds the `id` field from the record key.
 */
export type ParallelStepBuilderOutput = Omit<ParallelStepSpec, 'id'>;

export function parallelStep(
  spec: ParallelStepBuilderOutput,
): Result<ParallelStepBuilderOutput, FlowDefinitionError> {
  const result = parallelStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid parallel step'));

  return ok({
    ...spec,
    kind: 'parallel',
  });
}
