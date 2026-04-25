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
 * Extract and parse a JSON object or array from LLM response text. Handles
 * the three common LLM output formats:
 *   1. Raw JSON (ideal — delegate to safeParse)
 *   2. JSON wrapped in ```json ... ``` markdown fences
 *   3. JSON preceded by preamble text (finds first { or [)
 *
 * Returns an error only when no valid JSON can be found anywhere in the text.
 */
export function extractJson(text: string): Result<unknown, FlowDefinitionError> {
  // 1. Direct parse — ideal path, no extraction needed.
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    /* fall through */
  }

  // 2. Markdown code fence: ```json ... ``` or ``` ... ```
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    try {
      return ok(JSON.parse(fenceMatch[1].trim()) as unknown);
    } catch {
      /* fall through */
    }
  }

  // 3. Preamble before JSON: find the first { or [ and parse from there.
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    start = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
  }
  if (start > 0) {
    try {
      return ok(JSON.parse(text.slice(start)) as unknown);
    } catch {
      /* fall through */
    }
  }

  // Nothing worked — return the original parse error for the full text.
  try {
    JSON.parse(text);
    return ok(null); // unreachable
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
