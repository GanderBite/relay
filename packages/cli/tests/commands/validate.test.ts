/**
 * Tests for `relay validate` command.
 *
 * The command loads a flow and validates it synchronously, then exits with
 * a structured exit code. All I/O (flow loading) is mocked — no real disk
 * operations, no live Claude calls.
 *
 * Exit codes:
 *   0 — flow valid
 *   1 — FlowLoadError (runner_failure)
 *   2 — FlowDefinitionError (definition_error)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they are registered before module-under-test imports.
// ---------------------------------------------------------------------------

const mockLoadFlow = vi.hoisted(() => vi.fn());

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
  FlowLoadError: class FlowLoadError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.name = 'FlowLoadError';
      this.code = code;
    }
  },
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls.
// ---------------------------------------------------------------------------

import { err, FlowDefinitionError, ok } from '@ganderbite/relay-core';
import validateCommand from '../../src/commands/validate.js';
import { FlowLoadError } from '../../src/flow-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(name = 'my-flow', version = '1.0.0') {
  return {
    name,
    version,
    steps: {},
    stepOrder: [],
    graph: { topoOrder: [], rootSteps: [], predecessors: new Map(), successors: new Map() },
    input: undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stdoutOutput: string;
let stderrOutput: string;

beforeEach(() => {
  stdoutOutput = '';
  stderrOutput = '';

  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutOutput += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    stderrOutput += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay validate — success', () => {
  it('[VAL-001] valid flow prints name, version, "valid" to stdout and exits 0', async () => {
    const flow = makeFlow('my-flow', '1.2.3');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(validateCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('my-flow');
    expect(stdoutOutput).toContain('1.2.3');
    expect(stdoutOutput).toContain('valid');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('[VAL-002] success line contains the check symbol', async () => {
    const flow = makeFlow('hello-world', '0.1.0');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/hello-world' }));

    await expect(validateCommand(['hello-world'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('✓');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('[VAL-003] no output is written to stderr on success', async () => {
    mockLoadFlow.mockResolvedValue(ok({ flow: makeFlow(), dir: '/tmp/my-flow' }));

    await expect(validateCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toBe('');
  });
});

describe('relay validate — FlowDefinitionError (exit 2)', () => {
  it('[VAL-010] FlowDefinitionError prints error to stderr and exits 2', async () => {
    const defErr = new FlowDefinitionError('cycle detected in step graph');
    mockLoadFlow.mockResolvedValue(err(defErr));

    await expect(validateCommand(['bad-flow'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('cycle detected in step graph');
    expect(process.exit).toHaveBeenCalledWith(2);
  });

  it('[VAL-011] FlowDefinitionError does not write anything to stdout', async () => {
    const defErr = new FlowDefinitionError('step "missing" not in steps map');
    mockLoadFlow.mockResolvedValue(err(defErr));

    await expect(validateCommand(['bad-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toBe('');
  });
});

describe('relay validate — FlowLoadError (exit 1)', () => {
  it('[VAL-020] FlowLoadError (not found) prints error to stderr and exits 1', async () => {
    const loadErr = new FlowLoadError('flow "no-such-flow" not found', 'FLOW_NOT_FOUND');
    mockLoadFlow.mockResolvedValue(err(loadErr));

    await expect(validateCommand(['no-such-flow'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('not found');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('[VAL-021] FlowLoadError (invalid) prints error to stderr and exits 1', async () => {
    const loadErr = new FlowLoadError('flow package has no default export', 'FLOW_INVALID');
    mockLoadFlow.mockResolvedValue(err(loadErr));

    await expect(validateCommand(['./bad-pkg'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('no default export');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay validate — missing argument', () => {
  it('[VAL-030] no flow argument prints usage to stderr and exits 1', async () => {
    await expect(validateCommand([], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('usage');
    expect(stderrOutput).toContain('relay validate');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockLoadFlow).not.toHaveBeenCalled();
  });
});
