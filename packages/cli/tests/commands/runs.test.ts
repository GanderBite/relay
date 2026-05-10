/**
 * Tests for `relay runs` command.
 *
 * The command lists past runs from <cwd>/.relay/runs/, sorted newest first.
 * All filesystem access is mocked — no real disk I/O occurs.
 *
 * Also tests the exported relativeTime helper directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — registered before module-under-test imports.
// ---------------------------------------------------------------------------

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: mockReaddir,
    readFile: mockReadFile,
  };
});

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls.
// ---------------------------------------------------------------------------

import runsCommand, { relativeTime } from '../../src/commands/runs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<{
    runId: string;
    flowName: string;
    flowVersion: string;
    startedAt: string;
    updatedAt: string;
    status: string;
    completedAt: string;
    steps: Record<string, unknown>;
  }> = {},
) {
  return JSON.stringify({
    runId: overrides.runId ?? 'abc12345-0000-0000-0000-000000000000',
    flowName: overrides.flowName ?? 'codebase-discovery',
    flowVersion: overrides.flowVersion ?? '0.1.0',
    startedAt: overrides.startedAt ?? new Date(Date.now() - 7_200_000).toISOString(), // 2h ago
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    input: {},
    status: overrides.status ?? 'succeeded',
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    steps: overrides.steps ?? {},
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stdoutOutput: string;

beforeEach(() => {
  stdoutOutput = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutOutput += String(s);
    return true;
  });

  // Default process.argv — no flags.
  vi.stubEnv('_', '');
  Object.defineProperty(process, 'argv', {
    value: ['node', 'relay', 'runs'],
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// relativeTime unit tests
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  it('[RLT-001] returns "just now" for timestamps less than 60s ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    const result = relativeTime(new Date('2024-01-01T11:59:30Z').toISOString());
    expect(result).toBe('just now');

    vi.useRealTimers();
  });

  it('[RLT-002] returns minutes for timestamps between 60s and 3600s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    const result = relativeTime(new Date('2024-01-01T11:50:00Z').toISOString()); // 10 minutes ago
    expect(result).toBe('10m ago');

    vi.useRealTimers();
  });

  it('[RLT-003] returns hours for timestamps between 3600s and 86400s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    const result = relativeTime(new Date('2024-01-01T09:00:00Z').toISOString()); // 3h ago
    expect(result).toBe('3h ago');

    vi.useRealTimers();
  });

  it('[RLT-004] returns days for timestamps between 86400s and 604800s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-08T12:00:00Z'));

    const result = relativeTime(new Date('2024-01-05T12:00:00Z').toISOString()); // 3d ago
    expect(result).toBe('3d ago');

    vi.useRealTimers();
  });

  it('[RLT-005] returns weeks for timestamps older than 604800s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-01T12:00:00Z'));

    const result = relativeTime(new Date('2024-01-11T12:00:00Z').toISOString()); // ~3w ago
    expect(result).toBe('3w ago');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Command integration tests
// ---------------------------------------------------------------------------

describe('relay runs — empty run directory', () => {
  it('[RUN-001] prints "no runs yet" when runs dir does not exist', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await runsCommand([], {});

    expect(stdoutOutput).toContain('no runs yet');
    expect(stdoutOutput).toContain('relay run');
  });

  it('[RUN-002] prints the brand mark in the header', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await runsCommand([], {});

    expect(stdoutOutput).toContain('●─▶●─▶●─▶●');
  });

  it('[RUN-003] prints "recent runs" in the header', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await runsCommand([], {});

    expect(stdoutOutput).toContain('recent runs');
  });

  it('[RUN-004] prints "no runs yet" when runs dir exists but is empty', async () => {
    mockReaddir.mockResolvedValue([]);

    await runsCommand([], {});

    expect(stdoutOutput).toContain('no runs yet');
  });
});

describe('relay runs — populated run directory', () => {
  it('[RUN-010] renders a row for each run with flowName and version', async () => {
    const stateA = makeState({
      runId: 'aaaa0001-0000-0000-0000-000000000000',
      flowName: 'codebase-discovery',
      flowVersion: '0.1.0',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    const stateB = makeState({
      runId: 'bbbb0002-0000-0000-0000-000000000000',
      flowName: 'api-audit',
      flowVersion: '0.2.1',
      status: 'failed',
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    mockReaddir.mockResolvedValue(['run-a', 'run-b']);
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('run-a')) return Promise.resolve(stateA);
      if (String(path).includes('run-b')) return Promise.resolve(stateB);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await runsCommand([], {});

    expect(stdoutOutput).toContain('codebase-discovery');
    expect(stdoutOutput).toContain('api-audit');
    expect(stdoutOutput).toContain('v0.1.0');
    expect(stdoutOutput).toContain('v0.2.1');
  });

  it('[RUN-011] succeeded run shows ✓ status symbol', async () => {
    mockReaddir.mockResolvedValue(['run-ok']);
    mockReadFile.mockResolvedValue(
      makeState({ runId: 'cccc0003-0000-0000-0000-000000000000', status: 'succeeded' }),
    );

    await runsCommand([], {});

    expect(stdoutOutput).toContain('✓');
  });

  it('[RUN-012] failed run shows ✕ status symbol', async () => {
    mockReaddir.mockResolvedValue(['run-fail']);
    mockReadFile.mockResolvedValue(
      makeState({ runId: 'dddd0004-0000-0000-0000-000000000000', status: 'failed' }),
    );

    await runsCommand([], {});

    expect(stdoutOutput).toContain('✕');
  });

  it('[RUN-013] runs are sorted newest first', async () => {
    const newerState = makeState({
      runId: 'eeee0005-0000-0000-0000-000000000000',
      flowName: 'flow-newer',
      startedAt: new Date(Date.now() - 1_000).toISOString(), // 1 second ago
    });
    const olderState = makeState({
      runId: 'ffff0006-0000-0000-0000-000000000000',
      flowName: 'flow-older',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
    });

    // Files listed in reverse order to confirm sorting by startedAt, not dir order.
    mockReaddir.mockResolvedValue(['dir-older', 'dir-newer']);
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('dir-newer')) return Promise.resolve(newerState);
      if (String(path).includes('dir-older')) return Promise.resolve(olderState);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await runsCommand([], {});

    const newerPos = stdoutOutput.indexOf('flow-newer');
    const olderPos = stdoutOutput.indexOf('flow-older');
    expect(newerPos).toBeGreaterThan(-1);
    expect(olderPos).toBeGreaterThan(-1);
    expect(newerPos).toBeLessThan(olderPos);
  });

  it('[RUN-014] footer shows "relay resume <runId>" hint', async () => {
    mockReaddir.mockResolvedValue(['run-x']);
    mockReadFile.mockResolvedValue(makeState({ runId: 'gggg0007-0000-0000-0000-000000000000' }));

    await runsCommand([], {});

    expect(stdoutOutput).toContain('relay resume');
  });

  it('[RUN-015] run dir with missing state.json is silently skipped', async () => {
    mockReaddir.mockResolvedValue(['run-valid', 'run-broken']);
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('run-valid')) {
        return Promise.resolve(
          makeState({ runId: 'hhhh0008-0000-0000-0000-000000000000', flowName: 'good-flow' }),
        );
      }
      // run-broken/state.json does not exist.
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await runsCommand([], {});

    expect(stdoutOutput).toContain('good-flow');
    // Should not throw — broken dir was skipped.
  });
});

describe('relay runs — --status filter', () => {
  it('[RUN-020] --status succeeded filters to only succeeded runs', async () => {
    Object.defineProperty(process, 'argv', {
      value: ['node', 'relay', 'runs', '--status', 'succeeded'],
      configurable: true,
      writable: true,
    });

    const successState = makeState({
      runId: 'iiii0009-0000-0000-0000-000000000000',
      flowName: 'flow-ok',
      status: 'succeeded',
    });
    const failState = makeState({
      runId: 'jjjj0010-0000-0000-0000-000000000000',
      flowName: 'flow-bad',
      status: 'failed',
    });

    mockReaddir.mockResolvedValue(['run-ok', 'run-fail']);
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('run-ok')) return Promise.resolve(successState);
      if (String(path).includes('run-fail')) return Promise.resolve(failState);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await runsCommand([], {});

    expect(stdoutOutput).toContain('flow-ok');
    expect(stdoutOutput).not.toContain('flow-bad');
  });
});
