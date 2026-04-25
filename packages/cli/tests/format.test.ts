/**
 * Unit tests for the canonical formatting helpers in format.ts.
 *
 * These tests lock in the documented boundary behaviours so regressions
 * in user-visible token and duration strings are caught immediately.
 */

import { describe, expect, it } from 'vitest';

import { fmtCostApprox, fmtDuration, fmtK } from '../src/format.js';

// ---------------------------------------------------------------------------
// fmtK
// ---------------------------------------------------------------------------

describe('fmtK', () => {
  it('returns plain integer string for values below 1000', () => {
    expect(fmtK(0)).toBe('0');
    expect(fmtK(1)).toBe('1');
    expect(fmtK(999)).toBe('999');
  });

  it('returns "1.0K" for exactly 1000', () => {
    expect(fmtK(1000)).toBe('1.0K');
  });

  it('returns "12.3K" for 12300', () => {
    expect(fmtK(12300)).toBe('12.3K');
  });

  it('uses uppercase K suffix, not lowercase k', () => {
    expect(fmtK(1000)).toMatch(/K$/);
    expect(fmtK(12300)).toMatch(/K$/);
  });
});

// ---------------------------------------------------------------------------
// fmtDuration
// ---------------------------------------------------------------------------

describe('fmtDuration', () => {
  it('returns "0s" for zero milliseconds', () => {
    expect(fmtDuration(0)).toBe('0s');
  });

  it('returns one decimal second for sub-10-second values', () => {
    expect(fmtDuration(2100)).toBe('2.1s');
  });

  it('returns integer seconds for 10s–59s range', () => {
    expect(fmtDuration(15000)).toBe('15s');
  });

  it('returns "1m 0s" for exactly 60 seconds', () => {
    expect(fmtDuration(60000)).toBe('1m 0s');
  });
});

// ---------------------------------------------------------------------------
// fmtCostApprox
// ---------------------------------------------------------------------------

describe('fmtCostApprox', () => {
  it('returns "--" for exactly 0 (subscription billing has no measurable cost)', () => {
    expect(fmtCostApprox(0)).toBe('--');
  });

  it('returns "~$" prefixed value for non-zero costs', () => {
    expect(fmtCostApprox(0.004)).toBe('~$0.004');
  });
});
