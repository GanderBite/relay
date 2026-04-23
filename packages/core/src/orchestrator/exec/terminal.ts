import type { TerminalStepSpec } from '../../flow/types.js';
import type { StepExecutionContext } from '../orchestrator.js';

export interface TerminalStepResult {
  kind: 'terminal';
  terminal: true;
  exitCode: number;
}

export async function executeTerminal(
  step: TerminalStepSpec,
  ctx: StepExecutionContext,
): Promise<TerminalStepResult> {
  const exitCode = step.exitCode ?? 0;
  ctx.logger.info(
    { event: 'terminal', stepId: step.id, exitCode },
    step.message ?? 'Flow terminated',
  );
  return { kind: 'terminal', terminal: true, exitCode };
}
