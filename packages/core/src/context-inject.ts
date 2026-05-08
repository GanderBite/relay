import { err, ok, type Result } from 'neverthrow';

import type {
  FlowDefinitionError,
  HandoffIoError,
  HandoffNotFoundError,
  HandoffSchemaError,
} from './errors.js';
import { HandoffNotFoundError as HandoffNotFoundErrorClass } from './errors.js';
import type { HandoffStore } from './handoffs.js';
import { renderTemplate } from './template.js';
import { safeStringify } from './util/json.js';

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

  const entries = Object.entries(handoffs);
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

export type LoadHandoffValuesError =
  | HandoffNotFoundError
  | HandoffSchemaError
  | HandoffIoError
  | FlowDefinitionError;

/**
 * Parses an optional-suffix marker from a raw id string.
 *
 * A trailing '?' marks the handoff as optional — the caller should treat a
 * missing handoff as a null value rather than an error. The returned `name`
 * is always the id with the '?' stripped; `optional` reflects whether the
 * suffix was present.
 */
export function stripOptional(id: string): { name: string; optional: boolean } {
  if (id.endsWith('?')) {
    return { name: id.slice(0, -1), optional: true };
  }
  return { name: id, optional: false };
}

/**
 * Loads a set of handoff values from the store by id, preserving input order.
 *
 * Each id in the array may carry two special forms:
 *
 * - Trailing '?' (e.g. "review?"): the handoff is optional. If the store
 *   returns HandoffNotFoundError, the value is recorded as null and iteration
 *   continues. Any other error is propagated unchanged. The context key is the
 *   stripped name (no '?').
 *
 * - Dot-namespace (e.g. "fix_loop.review"): the id refers to the latest-pointer
 *   handoff written by a loop step. The string is split on the first '.' into
 *   [loopStepId, handoffName] and store.readLatest is called. The context key
 *   is the full dotted string. Dot-namespace and '?' may be combined
 *   (e.g. "fix_loop.review?").
 *
 * Plain ids (no '?', no '.') call store.read and fail fast on any error.
 *
 * The returned record's key order matches the input array order, so downstream
 * code that relies on Object.entries iteration order (such as assemblePrompt's
 * context-block emission) stays deterministic.
 */
export async function loadHandoffValues(
  store: HandoffStore,
  ids: string[],
): Promise<Result<Record<string, unknown>, LoadHandoffValuesError>> {
  const values: Record<string, unknown> = {};

  for (const rawId of ids) {
    const { name, optional } = stripOptional(rawId);
    const dotIndex = name.indexOf('.');

    if (dotIndex !== -1) {
      // Loop namespace reference: split on the first '.' only.
      const loopStepId = name.slice(0, dotIndex);
      const handoffName = name.slice(dotIndex + 1);
      const result = await store.readLatest(loopStepId, handoffName);
      if (result.isErr()) {
        if (optional && result.error instanceof HandoffNotFoundErrorClass) {
          values[name] = null;
          continue;
        }
        return err<Record<string, unknown>, LoadHandoffValuesError>(result.error);
      }
      values[name] = result.value;
    } else {
      // Plain id or optional plain id.
      const result = await store.read(name);
      if (result.isErr()) {
        if (optional && result.error instanceof HandoffNotFoundErrorClass) {
          values[name] = null;
          continue;
        }
        return err<Record<string, unknown>, LoadHandoffValuesError>(result.error);
      }
      values[name] = result.value;
    }
  }

  return ok(values);
}
