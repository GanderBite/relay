import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import {
  AwaitingInputSignal,
  type FlowDefinitionError,
  HandoffIoError,
  HandoffSchemaError,
} from '../../errors.js';
import { type AnswerMap, type Question, QuestionsArraySchema } from '../../flow/question.js';
import type { AskStepSpec } from '../../flow/types.js';
import type { HandoffStore } from '../../handoffs.js';
import { parseWithSchema } from '../../util/json.js';
import { z } from '../../zod.js';

/**
 * Discriminated result variant returned to the orchestrator on the resume
 * pass — when the answer file is already on disk and the step is treated
 * as succeeded. The first-pass behaviour of executeAsk is to throw
 * AwaitingInputSignal, so this shape is only constructed by the orchestrator
 * after executeAsk resolves with ok(answerMap).
 *
 * Carries the produced handoff name under `handoffs` so the StateMachine's
 * completeStep call records the published answer-map handoff alongside other
 * step outputs. The published name is the ask step's id — downstream steps
 * read it via `contextFrom: ['<askStepId>']` exactly like a prompt step's
 * handoff.
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
export type AskExecError = FlowDefinitionError | HandoffIoError | HandoffSchemaError;

/**
 * Stable key under which the CLI's `answer` command persists the collected
 * answer map for a paused ask step. The double-underscore prefix marks the
 * file as an internal handoff — the bytes are not part of the public DAG and
 * the file name intentionally fails the user-facing handoff id allowlist so
 * authors cannot collide with it from a flow definition.
 */
export function askAnswerHandoffKey(stepId: string): string {
  return `__ask_${stepId}__`;
}

/**
 * Resolve the on-disk path where the CLI writes the answer map for a paused
 * ask step and where executeAsk reads it back on resume. Exported so the CLI's
 * `answer` command can share the same convention without re-deriving the path.
 */
export function askAnswerHandoffPath(runDir: string, stepId: string): string {
  return join(runDir, 'handoffs', `${askAnswerHandoffKey(stepId)}.json`);
}

const AnswerMapSchema: z.ZodType<AnswerMap> = z.record(z.string(), z.unknown());

function errnoOf(cause: unknown): string | undefined {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Executes an ask step. The function has two branches:
 *
 * - First-pass (no answer file present): resolves the question list (static
 *   array or dynamic handoff source), then throws AwaitingInputSignal so the
 *   orchestrator can persist a paused snapshot and exit gracefully.
 * - Resume (answer file already present): reads and validates the answer map,
 *   returning it as ok so the orchestrator can record the step as succeeded
 *   and continue scheduling downstream steps.
 *
 * The answer file lives at `<runDir>/handoffs/__ask_<stepId>__.json` — the
 * underscore-prefixed key sits outside the user-facing handoff id allowlist
 * by design, so reads bypass HandoffStore and use a low-level JSON read here.
 * Any IO or schema failure is returned via the Result channel so the
 * orchestrator can map it to the same retry/abort surface as other step
 * executors.
 */
export async function executeAsk(
  spec: AskStepSpec,
  handoffStore: HandoffStore,
  stepId: string,
  runDir: string,
): Promise<Result<AnswerMap, AskExecError>> {
  const answerKey = askAnswerHandoffKey(stepId);
  const answerPath = askAnswerHandoffPath(runDir, stepId);

  // Resume path: a prior invocation already paused this step and the user
  // has since written an answer file via `relay answer`. Reading at the
  // conventional path bypasses HandoffStore.validateHandoffId, which rejects
  // ids starting with an underscore — the underscore prefix is the very
  // signal that this is an internal handoff. ENOENT is the expected
  // first-pass case and falls through to the AwaitingInputSignal throw below.
  let raw: string;
  try {
    raw = await readFile(answerPath, { encoding: 'utf8' });
  } catch (cause) {
    const errno = errnoOf(cause);
    if (errno !== 'ENOENT') {
      return err(
        new HandoffIoError(`failed to read handoff "${answerKey}"`, answerKey, {
          cause: messageOf(cause),
          ...(errno !== undefined ? { errno } : {}),
        }),
      );
    }
    // ENOENT — no answer yet. Fall through to the question-resolution +
    // AwaitingInputSignal throw below.
    raw = '';
  }

  if (raw !== '') {
    const parsed = parseWithSchema(raw, AnswerMapSchema);
    if (parsed.isErr()) {
      const issues = parsed.error.details?.['cause'];
      const issueArray = Array.isArray(issues) ? (issues as z.core.$ZodIssue[]) : [];
      return err(new HandoffSchemaError(parsed.error.message, answerKey, issueArray));
    }
    return ok(parsed.value);
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
