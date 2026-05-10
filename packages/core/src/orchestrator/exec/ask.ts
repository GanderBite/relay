import { err, ok, type Result } from 'neverthrow';

import {
  AwaitingInputSignal,
  type FlowDefinitionError,
  type HandoffIoError,
  HandoffNotFoundError,
  type HandoffSchemaError,
} from '../../errors.js';
import { type AnswerMap, type Question, QuestionsArraySchema } from '../../flow/question.js';
import type { AskStepSpec } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import { z } from '../../zod.js';

/**
 * Discriminated result variant returned to the orchestrator on the resume
 * pass — when the answer handoff is already on disk and the step is treated
 * as succeeded. The first-pass behaviour of executeAsk is to throw
 * AwaitingInputSignal, so this shape is only constructed by the orchestrator
 * after executeAsk resolves with ok(answerMap).
 *
 * Carries the answer-handoff key under `handoffs` so the StateMachine's
 * completeStep call records the produced handoff alongside other step outputs.
 */
export interface AskStepResult {
  kind: 'ask';
  stepId: string;
  answers: AnswerMap;
  handoffs: string[];
}

/**
 * Errors executeAsk surfaces via the Result channel. AwaitingInputSignal is
 * thrown (not returned) because it is a control-flow signal the orchestrator
 * intercepts to pause the run; everything in this union represents an actual
 * data-shape problem the operator must address before the run can continue.
 */
export type AskExecError =
  | FlowDefinitionError
  | HandoffIoError
  | HandoffNotFoundError
  | HandoffSchemaError;

/**
 * Stable key under which the orchestrator persists the answer map for a
 * paused ask step. Resume reads from this key to detect that the user has
 * already supplied input for this step on a previous invocation.
 */
export function askAnswerHandoffKey(stepId: string): string {
  return `__ask_${stepId}__`;
}

const AnswerMapSchema: z.ZodType<AnswerMap> = z.record(z.string(), z.unknown());

/**
 * Executes an ask step. The function has two branches:
 *
 * - First-pass (no answer handoff exists yet): resolves the question list
 *   (static array or dynamic handoff source), then throws AwaitingInputSignal
 *   so the orchestrator can persist a paused snapshot and exit gracefully.
 * - Resume (answer handoff already present): reads and validates the answer
 *   map, returning it as ok so the orchestrator can record the step as
 *   succeeded and continue scheduling downstream steps.
 *
 * Any handoff IO or schema failure is returned via the Result channel so the
 * orchestrator can map it to the same retry/abort surface as other step
 * executors.
 */
export async function executeAsk(
  spec: AskStepSpec,
  handoffStore: HandoffStore,
  stepId: string,
): Promise<Result<AnswerMap, AskExecError>> {
  const answerKey = askAnswerHandoffKey(stepId);

  // Resume path: a prior invocation already paused this step and the user
  // has since written an answer handoff via `relay answer`. Reading with a
  // schema separates the three failure modes — missing, malformed JSON, and
  // schema mismatch — onto distinct error classes the orchestrator can
  // discriminate. ENOENT (HandoffNotFoundError) is the expected first-pass
  // case and falls through to the AwaitingInputSignal throw below.
  const answerRead = await handoffStore.read(answerKey, AnswerMapSchema);
  if (answerRead.isOk()) {
    return ok(answerRead.value);
  }
  if (!(answerRead.error instanceof HandoffNotFoundError)) {
    return err(answerRead.error);
  }

  // First-pass path: resolve the question list before signalling the pause.
  // A static array is used as-is; a dynamic source is read from the named
  // handoff and validated against QuestionsArraySchema so an invalid producer
  // surfaces as a typed handoff error rather than a malformed question prompt.
  let questions: Question[];
  if (Array.isArray(spec.questions)) {
    questions = spec.questions;
  } else {
    const sourceRead = await handoffStore.read(spec.questions.from, QuestionsArraySchema);
    if (sourceRead.isErr()) {
      return err(sourceRead.error);
    }
    questions = sourceRead.value;
  }

  // Empty question list is intentional — the orchestrator writes an empty
  // answer map and treats the step as immediately resolved on the next
  // resume. The signal is still thrown so the orchestrator owns the
  // empty-answer write rather than splitting that policy across executors.
  throw new AwaitingInputSignal(stepId, questions);
}
