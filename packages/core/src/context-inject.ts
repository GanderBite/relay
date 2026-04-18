import type { Result } from 'neverthrow';

import type { FlowDefinitionError } from './errors.js';
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

/**
 * Loads a set of handoff values from the store by ID, preserving input order.
 * Propagates any error from store.read (e.g. missing file, schema mismatch).
 */
export async function loadHandoffValues(
  store: HandoffStore,
  ids: string[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const id of ids) {
    result[id] = await store.read(id);
  }
  return result;
}
