import { err, ok, type Result } from 'neverthrow';
import { toFlowDefError, type FlowDefinitionError } from '../../errors.js';
import { parallelStepSpecSchema } from '../schemas.js';
import type { ParallelStep, ParallelStepSpec } from '../types.js';

export function parallelStep(spec: ParallelStepSpec): Result<ParallelStep, FlowDefinitionError> {
  const result = parallelStepSpecSchema.safeParse(spec);
  if (!result.success) return err(toFlowDefError(result.error, 'invalid parallel step'));

  return ok({
    ...spec,
    kind: 'parallel',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  });
}
