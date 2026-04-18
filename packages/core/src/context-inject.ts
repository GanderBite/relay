import { err, ok, type Result } from 'neverthrow';

import type {
  FlowDefinitionError,
  HandoffIoError,
  HandoffNotFoundError,
  HandoffSchemaError,
} from './errors.js';
import type { HandoffStore } from './handoffs.js';
import { renderTemplate } from './template.js';

export interface AssemblePromptArgs {
  promptBody: string;
  handoffs: Record<string, unknown>;
  inputVars: Record<string, unknown>;
  stepVars?: Record<string, unknown>;
}

/**
 * Assembles the final prompt string sent to the provider.
 *
 * Var merge order: input first, handoffs next, stepVars last.
 * stepVars win on collision — per-step overrides beat flow-level handoffs.
 * Returns Err if the template fails to compile or render.
 */
export function assemblePrompt({
  promptBody,
  handoffs,
  inputVars,
  stepVars,
}: AssemblePromptArgs): Result<string, FlowDefinitionError> {
  const vars: Record<string, unknown> = {
    input: inputVars,
    ...handoffs,
    ...(stepVars ?? {}),
  };

  let contextBlocks = '';
  for (const [id, value] of Object.entries(handoffs)) {
    contextBlocks += `<context name="${id}">\n${JSON.stringify(value, null, 2)}\n</context>\n\n`;
  }

  return renderTemplate(promptBody, vars).map(
    (rendered) => contextBlocks + `<prompt>\n${rendered}\n</prompt>`,
  );
}

type LoadHandoffValuesError =
  | HandoffNotFoundError
  | HandoffSchemaError
  | HandoffIoError
  | FlowDefinitionError;

/**
 * Loads a set of handoff values from the store by id, preserving input order.
 *
 * Calls store.read(id) for each id in sequence with no schema (values are
 * loaded as raw unknown). Fails fast on the first err — callers that need to
 * surface multiple validation errors per run should loop and aggregate
 * themselves. The returned record's key order matches the input array order,
 * so downstream code that relies on Object.entries iteration order (such as
 * assemblePrompt's context-block emission) stays deterministic.
 */
export async function loadHandoffValues(
  store: HandoffStore,
  ids: string[],
): Promise<Result<Record<string, unknown>, LoadHandoffValuesError>> {
  const values: Record<string, unknown> = {};
  for (const id of ids) {
    const result = await store.read(id);
    if (result.isErr()) return err<Record<string, unknown>, LoadHandoffValuesError>(result.error);
    values[id] = result.value;
  }
  return ok(values);
}
