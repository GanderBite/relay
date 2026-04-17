import { FlowDefinitionError } from '../../errors.js';
import type { TerminalStepSpec, Step } from '../types.js';

export function terminalStep(spec: TerminalStepSpec): Step {
  if (spec.exitCode !== undefined) {
    if (!Number.isInteger(spec.exitCode) || spec.exitCode < 0 || spec.exitCode > 255) {
      throw new FlowDefinitionError(
        `terminal step "exitCode" must be a non-negative integer <= 255, got ${spec.exitCode}`,
      );
    }
  }

  const normalized: TerminalStepSpec & { id: string } = {
    ...spec,
    id: '',
    exitCode: spec.exitCode ?? 0,
  };

  return normalized;
}
