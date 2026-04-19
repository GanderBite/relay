import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { branchStepSpecSchema } from '../schemas.js';
import type { BranchStepSpec } from '../types.js';

/**
 * The shape returned by the branch builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type BranchStepBuilderOutput = Omit<BranchStepSpec, 'id'>;

export function branchStep(
  spec: BranchStepBuilderOutput,
): Result<BranchStepBuilderOutput, FlowDefinitionError> {
  const result = branchStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'branch' });
  if (!result.success) return err(toFlowDefError(result.error, 'invalid branch step'));

  return ok({
    ...spec,
    kind: 'branch',
  });
}
