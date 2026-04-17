import { FlowDefinitionError } from '../../errors.js';
import type { TerminalStep, TerminalStepSpec } from '../types.js';

export function terminalStep(spec: TerminalStepSpec): TerminalStep {
  if (spec.exitCode !== undefined) {
    if (!Number.isInteger(spec.exitCode) || spec.exitCode < 0 || spec.exitCode > 255) {
      throw new FlowDefinitionError(
        `terminal step "exitCode" must be a non-negative integer <= 255, got ${spec.exitCode}`,
      );
    }
  }

  return {
    ...spec,
    kind: 'terminal',
    id: '',
    exitCode: spec.exitCode ?? 0,
  };
}
