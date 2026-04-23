import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../errors.js';
import { z } from '../zod.js';

function escapeString(value: string): string {
  return value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

/**
 * Stringify a value for embedding in a prompt or other XML-tagged context.
 * Every `<` and `>` in string values is escaped to `\u003c` / `\u003e` so the
 * output cannot break out of a surrounding tag even if the value itself
 * contains something that looks like a tag close. Returns compact single-line
 * JSON — callers that need pretty-printed on-disk output should use
 * `atomicWriteJson` instead.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? escapeString(v) : v));
}

/**
 * Parse a JSON string into an unknown value. Returns a `FlowDefinitionError`
 * on any parse failure rather than throwing, so callers can chain `.mapErr`
 * to a more specific error type if needed.
 */
export function safeParse(text: string): Result<unknown, FlowDefinitionError> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(new FlowDefinitionError('JSON parse failed: ' + message, { cause: message }));
  }
}

/**
 * Parse a JSON string and validate the result against a Zod schema. Propagates
 * parse failures from `safeParse` and maps Zod validation failures to a
 * `FlowDefinitionError` whose message includes a human-readable summary of the
 * issues. Returns the typed value `T` on success so callers get a typed object,
 * not `unknown`.
 */
export function parseWithSchema<T>(
  text: string,
  schema: z.ZodType<T>,
): Result<T, FlowDefinitionError> {
  const parsed = safeParse(text);
  if (parsed.isErr()) return err(parsed.error);
  const validated = schema.safeParse(parsed.value);
  if (!validated.success) {
    return err(
      new FlowDefinitionError('JSON did not match schema: ' + z.prettifyError(validated.error), {
        cause: validated.error.issues,
      }),
    );
  }
  return ok(validated.data);
}
