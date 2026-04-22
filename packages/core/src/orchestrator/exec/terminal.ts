import type { TerminalRunnerSpec } from '../../race/types.js';
import type { RunnerExecutionContext } from '../orchestrator.js';

export interface TerminalRunnerResult {
  kind: 'terminal';
  terminal: true;
  exitCode: number;
}

export async function executeTerminal(
  runner: TerminalRunnerSpec,
  ctx: RunnerExecutionContext,
): Promise<TerminalRunnerResult> {
  const exitCode = runner.exitCode ?? 0;
  ctx.logger.info(
    { event: 'terminal', runnerId: runner.id, exitCode },
    runner.message ?? 'Race terminated',
  );
  return { kind: 'terminal', terminal: true, exitCode };
}
