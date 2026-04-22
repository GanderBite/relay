import { err, ok, type Result } from 'neverthrow';

import type {
  RaceDefinitionError,
  BatonIoError,
  BatonNotFoundError,
  BatonSchemaError,
} from './errors.js';
import type { BatonStore } from './batons.js';
import { renderTemplate } from './template.js';
import { safeStringify } from './util/json.js';

export interface AssemblePromptArgs {
  promptBody: string;
  batons: Record<string, unknown>;
  inputVars: Record<string, unknown>;
  runnerVars?: Record<string, unknown>;
}

/**
 * Assembles the final prompt string sent to the provider.
 *
 * Var merge order: input first, batons next, runnerVars last.
 * runnerVars win on collision — per-runner overrides beat race-level batons.
 * Returns Err if the template fails to compile or render.
 */
export function assemblePrompt({
  promptBody,
  batons,
  inputVars,
  runnerVars,
}: AssemblePromptArgs): Result<string, RaceDefinitionError> {
  const vars: Record<string, unknown> = {
    input: inputVars,
    ...batons,
    ...(runnerVars ?? {}),
  };

  const entries = Object.entries(batons);
  let contextBlock = '';
  if (entries.length > 0) {
    const inner = entries
      .map(([id, value]) => `  <c name="${id}">${safeStringify(value)}</c>`)
      .join('\n');
    contextBlock = `<context>\n${inner}\n</context>\n\n`;
  }

  return renderTemplate(promptBody, vars).map(
    (rendered) => contextBlock + `<prompt>\n${rendered}\n</prompt>`,
  );
}

type LoadBatonValuesError =
  | BatonNotFoundError
  | BatonSchemaError
  | BatonIoError
  | RaceDefinitionError;

/**
 * Loads a set of baton values from the store by id, preserving input order.
 *
 * Calls store.read(id) for each id in sequence with no schema (values are
 * loaded as raw unknown). Fails fast on the first err — callers that need to
 * surface multiple validation errors per run should loop and aggregate
 * themselves. The returned record's key order matches the input array order,
 * so downstream code that relies on Object.entries iteration order (such as
 * assemblePrompt's context-block emission) stays deterministic.
 */
export async function loadBatonValues(
  store: BatonStore,
  ids: string[],
): Promise<Result<Record<string, unknown>, LoadBatonValuesError>> {
  const values: Record<string, unknown> = {};
  for (const id of ids) {
    const result = await store.read(id);
    if (result.isErr()) return err<Record<string, unknown>, LoadBatonValuesError>(result.error);
    values[id] = result.value;
  }
  return ok(values);
}
