import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { promptStepSpecSchema } from '../schemas.js';
import type { PromptStepSpec } from '../types.js';

/**
 * The shape returned by the prompt builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type PromptStepBuilderOutput = Omit<PromptStepSpec, 'id'>;

export function promptStep(
  spec: PromptStepBuilderOutput,
): Result<PromptStepBuilderOutput, FlowDefinitionError> {
  const result = promptStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid prompt step'));

  return ok({
    ...spec,
    kind: 'prompt',
  });
}
