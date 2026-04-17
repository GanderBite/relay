import { z } from '../../zod.js';
import { FlowDefinitionError } from '../../errors.js';
import type { PromptStepSpec, Step } from '../types.js';

const ALLOWED_OUTPUT_KEYS = new Set(['handoff', 'artifact', 'schema']);

function validateOutput(output: PromptStepSpec['output']): void {
  const keys = Object.keys(output);
  const unknown = keys.filter(k => !ALLOWED_OUTPUT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new FlowDefinitionError(
      `prompt step output has unknown keys: ${unknown.join(', ')}`,
    );
  }

  const hasHandoff = 'handoff' in output;
  const hasArtifact = 'artifact' in output;

  if (!hasHandoff && !hasArtifact) {
    throw new FlowDefinitionError(
      'prompt step output must declare at least one of "handoff" or "artifact"',
    );
  }

  if ('schema' in output && output.schema !== undefined) {
    if (!(output.schema instanceof z.ZodType)) {
      throw new FlowDefinitionError(
        'prompt step output.schema must be a Zod schema when provided',
      );
    }
  }
}

export function promptStep(spec: PromptStepSpec): Step {
  if (!spec.promptFile || spec.promptFile.trim() === '') {
    throw new FlowDefinitionError(
      'prompt step requires a non-empty "promptFile"',
    );
  }

  if (spec.maxRetries !== undefined && spec.maxRetries < 0) {
    throw new FlowDefinitionError(
      `prompt step "maxRetries" must be >= 0, got ${spec.maxRetries}`,
    );
  }

  validateOutput(spec.output);

  const normalized: PromptStepSpec & { id: string } = {
    ...spec,
    // id is a placeholder; the flow compiler overwrites it with the record key
    id: '',
    maxRetries: spec.maxRetries ?? 0,
    timeoutMs: spec.timeoutMs ?? 600_000,
    onFail: spec.onFail ?? 'abort',
  };

  return normalized;
}
