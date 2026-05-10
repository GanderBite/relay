import { err, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import type { FlowGraph, LoopStep, Step } from '../types.js';

/**
 * Compile a loop step's body as its own flow graph. The recursive builder is
 * injected so the body module does not import `compose.ts` directly — that
 * would form a cycle, since compose calls buildBodyGraph for every loop step.
 *
 * Nested loops are rejected here: a loop body may not itself contain a `loop`
 * step. Flatten the body or extract the inner loop into a separate flow.
 */
export function buildBodyGraph(
  loopStep: LoopStep,
  recurse: (
    steps: Record<string, Step>,
    start: string | undefined,
    isBody: boolean,
  ) => Result<FlowGraph, FlowDefinitionError>,
): Result<FlowGraph, FlowDefinitionError> {
  const body = loopStep.body;
  for (const [bodyKey, bodyStep] of Object.entries(body)) {
    if (bodyStep === undefined) continue;
    if (bodyStep.kind === 'loop') {
      return err(
        new FlowDefinitionError(
          `loop step "${loopStep.id}" body contains nested loop step "${bodyKey}". Nested loops are not supported — flatten the body or move the inner loop into a separate flow.`,
        ),
      );
    }
  }
  return recurse(body, loopStep.start, true);
}
