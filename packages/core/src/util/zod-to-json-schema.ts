import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../errors.js';
import { z } from '../zod.js';

/**
 * Convert a Zod schema to an inlined JSON Schema Draft 7 object.
 *
 * Uses the native Zod v4 `z.toJSONSchema` API. Passing `reused: 'inline'`
 * suppresses $ref generation so the result is a single self-contained object —
 * required by Claude's structured-output endpoint.
 *
 * Returns a Result so callers handle failure explicitly rather than catching
 * thrown exceptions.
 */
export function zodToJsonSchema(schema: z.ZodType): Result<object, FlowDefinitionError> {
  try {
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07', reused: 'inline' });
    if (typeof jsonSchema !== 'object' || jsonSchema === null) {
      return err(new FlowDefinitionError('zod toJSONSchema returned a non-object value'));
    }
    return ok(jsonSchema);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(new FlowDefinitionError('failed to convert Zod schema to JSON Schema: ' + message));
  }
}
