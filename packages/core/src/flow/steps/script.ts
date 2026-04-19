import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { scriptStepSpecSchema } from '../schemas.js';
import type { ScriptStepSpec } from '../types.js';

/**
 * The shape returned by the script builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type ScriptStepBuilderOutput = Omit<ScriptStepSpec, 'id'>;

export function scriptStep(
  spec: ScriptStepBuilderOutput,
): Result<ScriptStepBuilderOutput, FlowDefinitionError> {
  const result = scriptStepSpecSchema.safeParse({ id: '_', kind: 'script', ...spec });
  if (!result.success) return err(toFlowDefError(result.error, 'invalid script step'));

  return ok({
    ...spec,
    kind: 'script',
  });
}
