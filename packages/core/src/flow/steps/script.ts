import { err, ok, type Result } from 'neverthrow';
import { toFlowDefError, type FlowDefinitionError } from '../../errors.js';
import { scriptStepSpecSchema } from '../schemas.js';
import type { ScriptStep, ScriptStepSpec } from '../types.js';

export function scriptStep(spec: ScriptStepSpec): Result<ScriptStep, FlowDefinitionError> {
  const result = scriptStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid script step'));

  return ok({
    ...spec,
    kind: 'script',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  });
}
