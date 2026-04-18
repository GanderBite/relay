import { err, ok, type Result } from 'neverthrow';
import { toFlowDefError, type FlowDefinitionError } from '../../errors.js';
import { terminalStepSpecSchema } from '../schemas.js';
import type { TerminalStep, TerminalStepSpec } from '../types.js';

export function terminalStep(spec: TerminalStepSpec): Result<TerminalStep, FlowDefinitionError> {
  const result = terminalStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid terminal step'));

  return ok({
    ...spec,
    kind: 'terminal',
    id: '',
    exitCode: spec.exitCode ?? 0,
  });
}
