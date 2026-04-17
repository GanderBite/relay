import { FlowDefinitionError } from '../../errors.js';
import type { ParallelStep, ParallelStepSpec } from '../types.js';

export function parallelStep(spec: ParallelStepSpec): ParallelStep {
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

  return {
    ...spec,
    kind: 'parallel',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  };
}
