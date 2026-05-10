/**
 * Tests for shell metacharacter rejection in scriptStep and branchStep builders.
 *
 * The builders call detectShellMetachars on string run values and throw
 * FlowDefinitionError when a metachar sequence is found. Array run values
 * bypass the check entirely — the caller is explicitly opting into shell
 * execution via ['sh', '-c', '<pipeline>'].
 */

import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../src/errors.js';
import { branchStep } from '../../src/flow/steps/branch.js';
import { scriptStep } from '../../src/flow/steps/script.js';

// ---------------------------------------------------------------------------
// scriptStep — metacharacter rejection
// ---------------------------------------------------------------------------

describe('scriptStep — shell metacharacter rejection', () => {
  it('[META-001] run="cd foo && bar" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'cd foo && bar' })).toThrow(FlowDefinitionError);
  });

  it('[META-002] FlowDefinitionError message contains "shell metacharacters"', () => {
    expect(() => scriptStep({ run: 'cd foo && bar' })).toThrow(/shell metacharacters/);
  });

  it('[META-003] FlowDefinitionError message includes the offending run string', () => {
    let caught: unknown;
    try {
      scriptStep({ run: 'cd foo && bar' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowDefinitionError);
    expect((caught as FlowDefinitionError).message).toContain('cd foo && bar');
  });

  it('[META-004] run with pipe "|" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'ls | grep foo' })).toThrow(FlowDefinitionError);
  });

  it('[META-005] run with "||" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'false || true' })).toThrow(FlowDefinitionError);
  });

  it('[META-006] run with command substitution "$(" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'echo $(whoami)' })).toThrow(FlowDefinitionError);
  });

  it('[META-007] run with backtick throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'echo `whoami`' })).toThrow(FlowDefinitionError);
  });

  it('[META-008] run with output redirect ">" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'echo hello > /tmp/out' })).toThrow(FlowDefinitionError);
  });

  it('[META-009] run with input redirect "<" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'cat < file.txt' })).toThrow(FlowDefinitionError);
  });

  it('[META-010] run with semicolon ";" throws FlowDefinitionError', () => {
    expect(() => scriptStep({ run: 'cd /tmp; ls' })).toThrow(FlowDefinitionError);
  });

  it('[META-011] run as array ["sh", "-c", "cd foo && bar"] does NOT throw', () => {
    expect(() => scriptStep({ run: ['sh', '-c', 'cd foo && bar'] })).not.toThrow();
  });

  it('[META-012] safe run string "echo hello" does NOT throw', () => {
    expect(() => scriptStep({ run: 'echo hello' })).not.toThrow();
  });

  it('[META-013] scriptStep returns object with kind "script" for a safe run', () => {
    const spec = scriptStep({ run: 'echo hello' });
    expect(spec.kind).toBe('script');
    expect(spec.run).toBe('echo hello');
  });
});

// ---------------------------------------------------------------------------
// branchStep — metacharacter rejection
// ---------------------------------------------------------------------------

describe('branchStep — shell metacharacter rejection', () => {
  it('[META-020] run="a | b" with onExit throws FlowDefinitionError', () => {
    expect(() => branchStep({ run: 'a | b', onExit: { '0': 'abort' } })).toThrow(
      FlowDefinitionError,
    );
  });

  it('[META-021] FlowDefinitionError message contains "shell metacharacters"', () => {
    expect(() => branchStep({ run: 'a | b', onExit: { '0': 'abort' } })).toThrow(
      /shell metacharacters/,
    );
  });

  it('[META-022] run with "&&" and onExit throws FlowDefinitionError', () => {
    expect(() =>
      branchStep({ run: 'check && verify', onExit: { '0': 'next', '1': 'abort' } }),
    ).toThrow(FlowDefinitionError);
  });

  it('[META-023] run as array ["sh", "-c", "a | b"] does NOT throw', () => {
    expect(() =>
      branchStep({ run: ['sh', '-c', 'a | b'], onExit: { '0': 'abort' } }),
    ).not.toThrow();
  });

  it('[META-024] safe run string does NOT throw', () => {
    expect(() =>
      branchStep({ run: './check.sh', onExit: { '0': 'next', '1': 'abort' } }),
    ).not.toThrow();
  });

  it('[META-025] branchStep returns object with kind "branch" for a safe run', () => {
    const spec = branchStep({ run: './check.sh', onExit: { '0': 'next' } });
    expect(spec.kind).toBe('branch');
    expect(spec.run).toBe('./check.sh');
  });
});

// ---------------------------------------------------------------------------
// Prefix accuracy — each step kind names itself in the error message
// ---------------------------------------------------------------------------

describe('shell metacharacter error message prefix matches step kind', () => {
  it('[META-026] scriptStep error starts with "script step:" and branchStep error starts with "branch step:"', () => {
    let scriptMsg = '';
    try {
      scriptStep({ run: 'check && verify' });
    } catch (e) {
      scriptMsg = (e as Error).message;
    }
    expect(scriptMsg).toMatch(/^script step:/);

    let branchMsg = '';
    try {
      branchStep({ run: 'check && verify', onExit: { '0': 'next', '1': 'abort' } });
    } catch (e) {
      branchMsg = (e as Error).message;
    }
    expect(branchMsg).toMatch(/^branch step:/);
  });
});
