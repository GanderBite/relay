/**
 * Tests for `relay new` command.
 *
 * Covers:
 *  - Invalid name exits 2
 *  - Mode A: skill installed + no --template → prints guidance and exits 0
 *  - Mode B: skill not installed + no --template → runs scaffoldFlow
 *  - Mode B: unknown template exits 2
 *  - Mode B: scaffoldFlow file-exists error exits 1
 *  - Mode B: scaffoldFlow succeeds → prints files written
 *
 * All filesystem, scaffold, and npm operations are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockStat = vi.hoisted(() => vi.fn());
const mockScaffoldFlow = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (...args: unknown[]) => mockStat(...args),
  };
});

vi.mock('@ganderbite/relay-generator/scaffold', () => ({
  scaffoldFlow: (...args: unknown[]) => mockScaffoldFlow(...args),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import newCommand from '../../src/commands/new.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScaffoldReport(fileNames: string[] = ['flow.ts', 'package.json']) {
  return {
    filesWritten: fileNames.map((f) => `/tmp/my-flow/${f}`),
  };
}

function captureStdout(): () => string {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    out += String(s);
    return true;
  });
  return () => out;
}

function captureStderr(): () => string {
  let out = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    out += String(s);
    return true;
  });
  return () => out;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

describe('relay new — name validation', () => {
  it('[NEW-001] empty name exits 2 with invalid-name message', async () => {
    const getStderr = captureStderr();
    captureStdout();

    await expect(newCommand([], {})).rejects.toThrow('process.exit:2');

    expect(process.exit).toHaveBeenCalledWith(2);
    expect(getStderr()).toContain('invalid flow name');
  });

  it('[NEW-002] uppercase name exits 2 with invalid-name message', async () => {
    const getStderr = captureStderr();
    captureStdout();

    await expect(newCommand(['MyFlow'], {})).rejects.toThrow('process.exit:2');

    expect(process.exit).toHaveBeenCalledWith(2);
    expect(getStderr()).toContain('invalid flow name');
    expect(getStderr()).toContain('MyFlow');
  });

  it('[NEW-003] name starting with a digit exits 2', async () => {
    const getStderr = captureStderr();
    captureStdout();

    await expect(newCommand(['1bad'], {})).rejects.toThrow('process.exit:2');

    expect(process.exit).toHaveBeenCalledWith(2);
    expect(getStderr()).toContain('invalid flow name');
  });
});

// ---------------------------------------------------------------------------
// Mode A — skill installed
// ---------------------------------------------------------------------------

describe('relay new — Mode A (skill installed)', () => {
  it('[NEW-004] prints guidance and exits 0 when skill is installed and no --template', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    const getStdout = captureStdout();
    captureStderr();

    await expect(newCommand(['my-flow'], {})).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    const out = getStdout();
    expect(out).toContain('scaffold a new relay flow');
  });

  it('[NEW-005] bypasses Mode A when --template is passed even if skill is installed', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockScaffoldFlow.mockResolvedValue(ok(makeScaffoldReport()));
    mockExecFileSync.mockReturnValue(undefined);
    captureStdout();
    captureStderr();

    await expect(newCommand(['my-flow'], { template: 'blank' })).rejects.toThrow('process.exit:0');

    // scaffoldFlow must have been called (Mode B path).
    expect(mockScaffoldFlow).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Mode B — no skill, template path
// ---------------------------------------------------------------------------

describe('relay new — Mode B (scaffold)', () => {
  beforeEach(() => {
    // Skill not installed.
    mockStat.mockRejectedValue(new Error('ENOENT'));
  });

  it('[NEW-006] invalid template name exits 2', async () => {
    const getStderr = captureStderr();
    captureStdout();

    await expect(newCommand(['my-flow'], { template: 'bad-template' })).rejects.toThrow(
      'process.exit:2',
    );

    expect(process.exit).toHaveBeenCalledWith(2);
    expect(getStderr()).toContain('unknown template');
    expect(getStderr()).toContain('bad-template');
  });

  it('[NEW-007] scaffoldFlow file-exists error exits 1 with overwrite hint', async () => {
    mockScaffoldFlow.mockResolvedValue(err({ kind: 'file-exists', path: '/tmp/my-flow/flow.ts' }));
    const getStderr = captureStderr();
    captureStdout();

    await expect(newCommand(['my-flow'], { template: 'blank' })).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(getStderr()).toContain('directory already exists');
    expect(getStderr()).toContain('--force');
  });

  it('[NEW-008] successful scaffold prints written files and try-it instructions', async () => {
    mockScaffoldFlow.mockResolvedValue(ok(makeScaffoldReport(['flow.ts', 'package.json'])));
    mockExecFileSync.mockReturnValue(undefined);
    const getStdout = captureStdout();
    captureStderr();

    await expect(newCommand(['my-flow'], { template: 'blank' })).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    const out = getStdout();
    expect(out).toContain('wrote');
    expect(out).toContain('relay run .');
  });
});
