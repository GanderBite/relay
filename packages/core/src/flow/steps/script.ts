import { FlowDefinitionError } from '../../errors.js';
import type { ScriptStepSpec, Step } from '../types.js';

// A string value for `run` will be shlex-split by the runtime before spawning.
const ON_EXIT_KEY_RE = /^\d+$/;

function validateRun(run: ScriptStepSpec['run']): void {
  if (typeof run === 'string') {
    if (run.trim() === '') {
      throw new FlowDefinitionError(
        'script step "run" must be a non-empty string',
      );
    }
    return;
  }

  if (!Array.isArray(run) || run.length === 0) {
    throw new FlowDefinitionError(
      'script step "run" must be a non-empty string or string array',
    );
  }

  for (let i = 0; i < run.length; i++) {
    const element = run[i];
    if (typeof element !== 'string' || element === '') {
      throw new FlowDefinitionError(
        `script step "run[${i}]" must be a non-empty string`,
      );
    }
  }
}

function validateOnExit(onExit: Record<string, string>): void {
  for (const key of Object.keys(onExit)) {
    if (key !== 'default' && !ON_EXIT_KEY_RE.test(key)) {
      throw new FlowDefinitionError(
        `script step "onExit" key "${key}" is not valid — must be 'default' or a non-negative integer string`,
      );
    }

    const value = onExit[key];
    if (value === undefined || (value !== 'abort' && value !== 'continue' && value.trim() === '')) {
      throw new FlowDefinitionError(
        `script step "onExit['${key}']" must be 'abort', 'continue', or a non-empty step ID`,
      );
    }
  }
}

export function scriptStep(spec: ScriptStepSpec): Step {
  validateRun(spec.run);

  if (spec.maxRetries !== undefined && spec.maxRetries < 0) {
    throw new FlowDefinitionError(
      `script step "maxRetries" must be >= 0, got ${spec.maxRetries}`,
    );
  }

  if (spec.onExit !== undefined) {
    validateOnExit(spec.onExit);
  }

  const normalized: ScriptStepSpec & { id: string } = {
    ...spec,
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    onFail: spec.onFail ?? 'abort',
  };

  return normalized;
}
