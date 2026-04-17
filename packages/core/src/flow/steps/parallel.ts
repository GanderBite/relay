import { FlowDefinitionError } from '../../errors.js';
import type { ParallelStepSpec, Step } from '../types.js';

export function parallelStep(spec: ParallelStepSpec): Step {
  if (!Array.isArray(spec.branches) || spec.branches.length === 0) {
    throw new FlowDefinitionError(
      'parallel step "branches" must be a non-empty array',
    );
  }

  for (const branch of spec.branches) {
    if (typeof branch !== 'string' || branch.trim() === '') {
      throw new FlowDefinitionError(
        'parallel step "branches" must contain only non-empty strings',
      );
    }
  }

  if (spec.maxRetries !== undefined && spec.maxRetries < 0) {
    throw new FlowDefinitionError(
      `parallel step "maxRetries" must be >= 0, got ${spec.maxRetries}`,
    );
  }

  const normalized: ParallelStepSpec & { id: string } = {
    ...spec,
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  };

  return normalized;
}
