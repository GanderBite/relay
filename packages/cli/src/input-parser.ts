/**
 * Argv-to-Zod input parser.
 *
 * Parses a raw argv array (everything after the command name) into a typed
 * object that satisfies a ZodObject schema. Supports:
 *   - Named flags:  --key=value  or  --key value
 *   - Positional args that fill required string/number fields in declaration order
 *   - Type coercion for ZodNumber (parse float) and ZodBoolean (true/false/1/0)
 *   - Default and optional fields are skipped during positional assignment
 *
 * Returns ok(parsed) on success or err(FlowDefinitionError) on failure.
 */

import { err, FlowDefinitionError, ok, type Result, z } from '@ganderbite/relay-core';

// ---------------------------------------------------------------------------
// Internal type helpers
//
// z.ZodObject.shape returns Shape, which is constrained to z.ZodRawShape.
// z.ZodRawShape = z.core.$ZodShape = Readonly<{ [k: string]: z.core.$ZodType }>.
// The values are typed as the core interface ($ZodType), not the classic class
// interface (ZodType). All schema instances created with the classic z.* API are
// ZodType instances at runtime, so we use a type guard to narrow once.
// ---------------------------------------------------------------------------

/**
 * Narrow a core.$ZodType value (from shape iteration) to the classic z.ZodType.
 * Returns true when the value is a real Zod class instance.
 */
function isZodType(v: z.core.$ZodType): v is z.ZodType {
  return v instanceof z.ZodType;
}

// ---------------------------------------------------------------------------
// Field-level helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a ZodDefault or ZodOptional wrapper to reach the inner ZodType.
 * Only one layer deep — real schemas don't nest wrappers here.
 */
function unwrapField(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodDefault) {
    const inner: unknown = field._zod.def.innerType;
    if (inner instanceof z.ZodType) return inner;
  }
  if (field instanceof z.ZodOptional) {
    const inner: unknown = field._zod.def.innerType;
    if (inner instanceof z.ZodType) return inner;
  }
  return field;
}

/** Return true when the field has no default and is not optional. */
function isRequired(field: z.ZodType): boolean {
  return !(field instanceof z.ZodDefault) && !(field instanceof z.ZodOptional);
}

/** Return true when the innermost type accepts string input. */
function isStringLike(field: z.ZodType): boolean {
  return unwrapField(field) instanceof z.ZodString;
}

/** Return true when the innermost type expects a number. */
function isNumberLike(field: z.ZodType): boolean {
  return unwrapField(field) instanceof z.ZodNumber;
}

/** Return true when the innermost type expects a boolean. */
function isBooleanLike(field: z.ZodType): boolean {
  return unwrapField(field) instanceof z.ZodBoolean;
}

/**
 * Coerce a raw argv string to the appropriate JS type for this schema field.
 * Throws FlowDefinitionError on bad input so the caller can bubble it as err().
 */
function coerce(raw: string, field: z.ZodType): unknown {
  const inner = unwrapField(field);

  if (inner instanceof z.ZodNumber) {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      throw new FlowDefinitionError(`expected a number but received "${raw}"`);
    }
    return n;
  }

  if (inner instanceof z.ZodBoolean) {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new FlowDefinitionError(`expected true/false/1/0 but received "${raw}"`);
  }

  // ZodString, ZodEnum, ZodLiteral, or anything else — pass the string through.
  return raw;
}

// ---------------------------------------------------------------------------
// parseInputFromArgv
// ---------------------------------------------------------------------------

/**
 * Parse a raw argv slice into a validated object that satisfies the given
 * ZodObject schema.
 *
 * Argument resolution order:
 *   1. Named flags: --key=value or --key value  (always wins)
 *   2. Positionals: fill required string/number fields in schema declaration order
 *   3. Zod .parse() validates the assembled object and surfaces field errors
 *
 * The schema must be a ZodObject. Any other Zod type returns an immediate error.
 *
 * @param schema  A ZodObject schema describing the expected input shape.
 * @param args    The argv slice to parse, e.g. process.argv.slice(3).
 */
export function parseInputFromArgv(
  schema: z.ZodType,
  args: string[],
): Result<unknown, FlowDefinitionError> {
  if (!(schema instanceof z.ZodObject)) {
    return err(
      new FlowDefinitionError(
        'input schema must be a ZodObject — other Zod types are not supported for argv parsing',
      ),
    );
  }

  const shape = schema.shape;
  const raw: Record<string, unknown> = {};

  // -------------------------------------------------------------------------
  // Pass 1 — extract named flags from argv, collect positionals
  // -------------------------------------------------------------------------
  const positionals: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf('=');

      if (eqIdx !== -1) {
        // --key=value
        const key = body.slice(0, eqIdx);
        const rawValue = body.slice(eqIdx + 1);
        const fieldRaw = shape[key];

        if (fieldRaw !== undefined && isZodType(fieldRaw)) {
          try {
            raw[key] = coerce(rawValue, fieldRaw);
          } catch (coerceErr) {
            if (coerceErr instanceof FlowDefinitionError) return err(coerceErr);
            return err(new FlowDefinitionError(String(coerceErr)));
          }
        } else {
          // Unknown flag — pass through as string so Zod can surface the error.
          raw[key] = rawValue;
        }
      } else {
        // --key value  (peek at the next token)
        const key = body;
        const next = args[i + 1];
        const fieldRaw = shape[key];
        const field = fieldRaw !== undefined && isZodType(fieldRaw) ? fieldRaw : undefined;

        // Boolean flags can appear without a value: --verbose
        if (
          field !== undefined &&
          isBooleanLike(field) &&
          (next === undefined || next.startsWith('--'))
        ) {
          raw[key] = true;
          i++;
          continue;
        }

        if (next !== undefined && !next.startsWith('--')) {
          if (field !== undefined) {
            try {
              raw[key] = coerce(next, field);
            } catch (coerceErr) {
              if (coerceErr instanceof FlowDefinitionError) return err(coerceErr);
              return err(new FlowDefinitionError(String(coerceErr)));
            }
          } else {
            // Unknown flag with a following value.
            raw[key] = next;
          }
          i += 2;
          continue;
        }

        // No following value (or next is also a flag) — treat as bare boolean.
        raw[key] = true;
      }
    } else {
      positionals.push(arg);
    }

    i++;
  }

  // -------------------------------------------------------------------------
  // Pass 2 — assign positionals to required string/number fields in order
  // -------------------------------------------------------------------------
  let posIdx = 0;

  for (const [key, fieldRaw] of Object.entries(shape)) {
    if (posIdx >= positionals.length) break;
    // Skip fields already set by named flags.
    if (key in raw) continue;
    // Only fill required fields (no default, not optional).
    if (!isZodType(fieldRaw) || !isRequired(fieldRaw)) continue;
    // Only string-like or number-like fields are filled from positionals.
    if (!isStringLike(fieldRaw) && !isNumberLike(fieldRaw)) continue;

    const pos = positionals[posIdx];
    if (pos === undefined) break;

    try {
      raw[key] = coerce(pos, fieldRaw);
    } catch (coerceErr) {
      if (coerceErr instanceof FlowDefinitionError) return err(coerceErr);
      return err(new FlowDefinitionError(String(coerceErr)));
    }

    posIdx++;
  }

  // -------------------------------------------------------------------------
  // Pass 3 — validate the assembled object against the full schema
  // -------------------------------------------------------------------------
  const result = schema.safeParse(raw);

  if (!result.success) {
    const message = buildIssueMessage(result.error);
    return err(new FlowDefinitionError(message, { issues: result.error.issues }));
  }

  return ok(result.data);
}

/** Format a ZodError's issues into a single human-readable message. */
function buildIssueMessage(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${path}: ${issue.message}`;
  });
  return `invalid input:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// renderHelpFromSchema
// ---------------------------------------------------------------------------

/**
 * Produce a plain-text usage string from a ZodObject schema.
 *
 * Output format — one row per field, three columns:
 *
 *   option            type     description
 *   ─────────────────────────────────────────────────────────
 *   --fieldName       string   description from .describe()
 *   --optionalField   number   description (optional)
 *
 * No ANSI color — this string is handed to commander's help system.
 *
 * @param schema  A ZodObject schema. Non-object schemas return an empty string.
 */
export function renderHelpFromSchema(schema: z.ZodType): string {
  if (!(schema instanceof z.ZodObject)) {
    return '';
  }

  const shape = schema.shape;

  type Row = { flag: string; typeName: string; desc: string; required: boolean };
  const data: Row[] = [];

  let maxFlag = 'option'.length;
  let maxType = 'type'.length;

  for (const [key, fieldRaw] of Object.entries(shape)) {
    if (!isZodType(fieldRaw)) continue;

    const flag = `--${key}`;
    const typeName = resolveTypeName(fieldRaw);
    const desc = fieldRaw.description ?? '';
    const required = isRequired(fieldRaw);

    if (flag.length > maxFlag) maxFlag = flag.length;
    if (typeName.length > maxType) maxType = typeName.length;

    data.push({ flag, typeName, desc, required });
  }

  const rows: string[] = [];

  rows.push(`${'option'.padEnd(maxFlag)}  ${'type'.padEnd(maxType)}  description`);
  rows.push(`${'─'.repeat(maxFlag)}  ${'─'.repeat(maxType)}  ${'─'.repeat(40)}`);

  for (const { flag, typeName, desc, required } of data) {
    const optMarker = required ? '' : ' (optional)';
    const descText = desc + optMarker;
    rows.push(`${flag.padEnd(maxFlag)}  ${typeName.padEnd(maxType)}  ${descText}`.trimEnd());
  }

  return rows.join('\n');
}

/**
 * Resolve a human-readable type label for a schema field.
 * Unwraps ZodDefault and ZodOptional before checking the inner type.
 */
function resolveTypeName(field: z.ZodType): string {
  const inner = unwrapField(field);

  if (inner instanceof z.ZodString) return 'string';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodBoolean) return 'boolean';

  if (inner instanceof z.ZodEnum) {
    const def = inner._zod.def as { entries: Record<string, string> };
    const values = Object.values(def.entries);
    return values.join('|');
  }

  if (inner instanceof z.ZodArray) {
    return 'string[]';
  }

  // ZodUnion, ZodObject, ZodLiteral, etc. — fall back to a generic label.
  return 'value';
}
