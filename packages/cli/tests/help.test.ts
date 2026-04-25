/**
 * Verifies the splash help output shape — specifically that the dead shorthand
 * form `relay <flow> [input]` has been removed and the explicit form
 * `relay run <flow> [input]` is still present.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSplash } from '../src/help.js';

describe('renderSplash', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  function captureOutput(): string {
    renderSplash();
    return writeSpy.mock.calls.map((args) => String(args[0])).join('');
  }

  it('does not advertise the relay <flow> [input] shorthand', () => {
    const output = captureOutput();
    expect(output.includes('relay <flow> [input]')).toBe(false);
  });

  it('preserves the relay run <flow> [input] explicit form', () => {
    const output = captureOutput();
    expect(output.includes('relay run <flow> [input]')).toBe(true);
  });
});
