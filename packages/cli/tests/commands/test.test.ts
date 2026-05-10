/**
 * Tests for `relay test <flow>` command.
 *
 * Smoke tests covering:
 *  - Missing flow argument → exits with definition_error
 *  - loadFlow failure → exits with definition_error
 *  - No fixtures directory → exits 0 with friendly message
 *  - Fixtures directory exists but is empty → exits 0
 *
 * All I/O (filesystem, loadFlow) is mocked — no live orchestrator, no
 * real Claude subprocess calls, no real disk writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockLoadFlow = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsReaddir = vi.hoisted(() => vi.fn());
const mockFsReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockFsMkdir = vi.hoisted(() => vi.fn());
const mockFsRm = vi.hoisted(() => vi.fn());

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

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (...args: unknown[]) => mockFsStat(...args),
    readdir: (...args: unknown[]) => mockFsReaddir(...args),
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    rm: (...args: unknown[]) => mockFsRm(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import testCommand from '../../src/commands/test.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalFlow(stepIds: string[] = ['step1']) {
  const steps: Record<string, unknown> = {};
  for (const id of stepIds) steps[id] = { id, kind: 'script', run: 'echo ok' };
  return {
    name: 'test-flow',
    version: '0.1.0',
    steps,
    graph: {
      topoOrder: stepIds,
      rootSteps: stepIds.slice(0, 1),
      predecessors: new Map(),
      successors: new Map(),
    },
    input: undefined,
  };
}

function captureWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Missing argument
// ---------------------------------------------------------------------------

describe('relay test — missing argument', () => {
  it('[TEST-001] exits 2 with usage message when no flow argument is provided', async () => {
    await expect(testCommand([], {})).rejects.toThrow('process.exit:2');

    expect(process.exit).toHaveBeenCalledWith(2);
    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('usage: relay test <flow>');
  });
});

// ---------------------------------------------------------------------------
// loadFlow failure
// ---------------------------------------------------------------------------

describe('relay test — loadFlow failure', () => {
  it('[TEST-002] exits with definition_error when loadFlow returns an error', async () => {
    mockLoadFlow.mockResolvedValue(err(new Error('flow not found')));

    await expect(testCommand(['/tmp/no-flow'], {})).rejects.toThrow('process.exit:');

    expect(process.exit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No fixtures directory
// ---------------------------------------------------------------------------

describe('relay test — no fixtures', () => {
  it('[TEST-003] exits 0 with friendly message when fixtures directory does not exist', async () => {
    mockLoadFlow.mockResolvedValue(ok({ flow: makeMinimalFlow(), dir: '/tmp/test-flow' }));
    // stat throws (directory does not exist)
    mockFsStat.mockRejectedValue(new Error('ENOENT'));

    await expect(testCommand(['/tmp/test-flow'], {})).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('no test fixtures found');
  });

  it('[TEST-004] exits 0 with friendly message when fixtures directory exists but is empty', async () => {
    mockLoadFlow.mockResolvedValue(ok({ flow: makeMinimalFlow(), dir: '/tmp/test-flow' }));
    // stat: fixtures dir exists and is a directory
    mockFsStat.mockResolvedValue({ isDirectory: () => true });
    // readdir: returns no JSON files
    mockFsReaddir.mockResolvedValue([]);

    await expect(testCommand(['/tmp/test-flow'], {})).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('no test fixtures found');
  });
});
