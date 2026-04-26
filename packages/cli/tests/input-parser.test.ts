/**
 * Unit tests for the argv-to-Zod input parser.
 *
 * TC-012: Positional args are assigned to required schema fields in declaration order.
 * TC-013: Named --key=value flags take precedence over positional assignment.
 */

import { z } from '@ganderbite/relay-core';
import { describe, expect, it } from 'vitest';

import { parseInputFromArgv } from '../src/input-parser.js';

describe('parseInputFromArgv', () => {
  const nameSchema = z.object({
    firstName: z.string().describe('First name'),
    lastName: z.string().describe('Last name'),
  });

  // -------------------------------------------------------------------------
  // TC-012
  // -------------------------------------------------------------------------

  it('[TC-012] positional args assigned to required fields in declaration order', () => {
    const r = parseInputFromArgv(nameSchema, ['Alice', 'Wonderland']);

    expect(r.isOk()).toBe(true);

    const value = r._unsafeUnwrap() as { firstName: string; lastName: string };
    expect(value.firstName).toBe('Alice');
    expect(value.lastName).toBe('Wonderland');
  });

  // -------------------------------------------------------------------------
  // TC-013
  // -------------------------------------------------------------------------

  it('[TC-013] named --key=value flags take precedence over positional assignment', () => {
    const r = parseInputFromArgv(nameSchema, ['--firstName=Alice', 'Wonderland']);

    expect(r.isOk()).toBe(true);

    const value = r._unsafeUnwrap() as { firstName: string; lastName: string };
    expect(value.firstName).toBe('Alice');
    expect(value.lastName).toBe('Wonderland');
  });
});
