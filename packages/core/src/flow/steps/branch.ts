import { FlowDefinitionError } from '../../errors.js';
import type { BranchStep, BranchStepSpec } from '../types.js';

const EXIT_KEY_RE = /^\d+$/;

function isValidExitKey(key: string): boolean {
  return key === 'default' || EXIT_KEY_RE.test(key);
}

function validateOnExit(onExit: Record<string, 'abort' | 'continue' | string>): void {
  const keys = Object.keys(onExit);

  if (keys.length === 0) {
    throw new FlowDefinitionError(
      'branch step requires a non-empty `onExit` map',
    );
  }

  for (const key of keys) {
    if (!isValidExitKey(key)) {
      throw new FlowDefinitionError(
        `branch step onExit key "${key}" must be "default" or a numeric string`,
      );
    }

    const value = onExit[key];
    if (value === undefined || (value !== 'abort' && value !== 'continue' && value.trim() === '')) {
      throw new FlowDefinitionError(
        `branch step onExit["${key}"] must be "abort", "continue", or a non-empty step id`,
      );
    }
  }
}

export function branchStep(spec: BranchStepSpec): BranchStep {
  const run = spec.run;
  if (!run || (typeof run === 'string' && run.trim() === '')) {
    throw new FlowDefinitionError(
      'branch step requires a non-empty "run" command',
    );
  }
  if (Array.isArray(run) && run.length === 0) {
    throw new FlowDefinitionError(
      'branch step "run" array must not be empty',
    );
  }

  if (spec.maxRetries !== undefined && spec.maxRetries < 0) {
    throw new FlowDefinitionError(
      `branch step "maxRetries" must be >= 0, got ${spec.maxRetries}`,
    );
  }

  validateOnExit(spec.onExit);

  return {
    ...spec,
    kind: 'branch',
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  };
}
