import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, toFlowDefError } from '../../errors.js';
import { branchStepSpecSchema } from '../schemas.js';
import type { BranchStep, BranchStepSpec } from '../types.js';

export function branchStep(spec: BranchStepSpec): Result<BranchStep, FlowDefinitionError> {
  const result = branchStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid branch step'));

  return ok({
    ...spec,
    kind: 'branch',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  });
}
