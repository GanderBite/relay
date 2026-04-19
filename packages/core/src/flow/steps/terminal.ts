import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { terminalStepSpecSchema } from '../schemas.js';
import type { TerminalStepSpec } from '../types.js';

/**
 * The shape returned by the terminal builder before the flow compiler assigns
 * an id. `defineFlow` adds the `id` field from the record key.
 */
export type TerminalStepBuilderOutput = Omit<TerminalStepSpec, 'id'>;

export function terminalStep(
  spec: TerminalStepBuilderOutput,
): Result<TerminalStepBuilderOutput, FlowDefinitionError> {
  const result = terminalStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'terminal' });
  if (!result.success) return err(toFlowDefError(result.error, 'invalid terminal step'));

  return ok({
    ...spec,
    kind: 'terminal',
  });
}
