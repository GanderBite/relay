import { err, ok, type Result } from 'neverthrow';
import { toFlowDefError, type FlowDefinitionError } from '../../errors.js';
import { promptStepSpecSchema } from '../schemas.js';
import type { PromptStep, PromptStepSpec } from '../types.js';

export function promptStep(spec: PromptStepSpec): Result<PromptStep, FlowDefinitionError> {
  const result = promptStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid prompt step'));

  return ok({
    ...spec,
    kind: 'prompt',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    timeoutMs: spec.timeoutMs ?? 600_000,
    onFail: spec.onFail ?? 'abort',
  });
}
