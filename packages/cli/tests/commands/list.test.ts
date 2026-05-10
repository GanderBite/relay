/**
 * Tests for `relay list` command.
 *
 * The command scans local flows, workspace flows, and a remote catalog,
 * then prints a table of installed flows. All FS and network access is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — registered before module-under-test imports.
// ---------------------------------------------------------------------------

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: mockReaddir,
    readFile: mockReadFile,
  };
});

// Replace global fetch so no real network calls occur.
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls.
// ---------------------------------------------------------------------------

import listCommand from '../../src/commands/list.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePackageJson(
  name: string,
  version = '1.0.0',
  description = 'A test flow',
  relay: Record<string, unknown> = {},
): string {
  return JSON.stringify({ name, version, description, relay });
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

  // Default: remote catalog network call fails (no network in tests).
  mockFetch.mockRejectedValue(new Error('Network unavailable'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay list — empty state', () => {
  it('[LST-001] prints "no flows installed" when no flows are found anywhere', async () => {
    // Both .relay/flows and node_modules/@ganderbite dirs do not exist.
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await listCommand([], {});

    expect(stdoutOutput).toContain('no flows installed');
    expect(stdoutOutput).toContain('relay search <query>');
  });

  it('[LST-002] prints catalog unavailability note when remote fails', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await listCommand([], {});

    expect(stdoutOutput).toContain('catalog unavailable');
  });

  it('[LST-003] prints the brand mark in the header', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await listCommand([], {});

    expect(stdoutOutput).toContain('●─▶●─▶●─▶●');
  });

  it('[LST-004] prints "installed flows" phrase in the header', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await listCommand([], {});

    expect(stdoutOutput).toContain('installed flows');
  });
});

describe('relay list — populated local flows', () => {
  it('[LST-010] renders a table row for each local flow', async () => {
    // .relay/flows contains two flow directories.
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes('.relay/flows')) {
        return Promise.resolve(['codebase-discovery', 'api-audit']);
      }
      // node_modules/@ganderbite does not exist.
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('codebase-discovery')) {
        return Promise.resolve(
          makePackageJson(
            '@ganderbite/flow-codebase-discovery',
            '0.1.0',
            'PM-ready report on an unknown repo',
            { estimatedCostUsd: 0.4, estimatedDurationMin: 20 },
          ),
        );
      }
      if (String(path).includes('api-audit')) {
        return Promise.resolve(
          makePackageJson(
            '@ganderbite/flow-api-audit',
            '0.2.1',
            'Surface stale or risky HTTP routes',
            { estimatedCostUsd: 0.25, estimatedDurationMin: 15 },
          ),
        );
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await listCommand([], {});

    expect(stdoutOutput).toContain('codebase-discovery');
    expect(stdoutOutput).toContain('api-audit');
    expect(stdoutOutput).toContain('v0.1.0');
    expect(stdoutOutput).toContain('v0.2.1');
  });

  it('[LST-011] footer shows installed count and search hint', async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes('.relay/flows')) {
        return Promise.resolve(['codebase-discovery']);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockReadFile.mockResolvedValue(
      makePackageJson('@ganderbite/flow-codebase-discovery', '0.1.0', 'A flow'),
    );

    await listCommand([], {});

    expect(stdoutOutput).toMatch(/1 flows? installed/);
    expect(stdoutOutput).toContain('relay search <query>');
  });

  it('[LST-012] deduplicates flows that appear in both local and remote sources', async () => {
    // Local has codebase-discovery.
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes('.relay/flows')) {
        return Promise.resolve(['codebase-discovery']);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockReadFile.mockResolvedValue(
      makePackageJson('@ganderbite/flow-codebase-discovery', '0.1.0', 'Local version'),
    );

    // Remote also has codebase-discovery — should be deduped.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: '@ganderbite/flow-codebase-discovery',
            version: '0.2.0',
            description: 'Remote version',
            relay: { displayName: 'codebase-discovery' },
          },
        ]),
    });

    await listCommand([], {});

    // Should appear exactly once (the local version wins).
    const occurrences = (stdoutOutput.match(/codebase-discovery/g) ?? []).length;
    // The name appears in the row; it should not be doubled into two rows.
    // The footer line and header do not contain the flow name, so count must be 1.
    expect(occurrences).toBe(1);
  });

  it('[LST-013] workspace flows from node_modules/@ganderbite are listed', async () => {
    // No local .relay/flows.
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes('.relay/flows')) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      // node_modules/@ganderbite exists with one flow package.
      if (String(dir).includes('@ganderbite')) {
        return Promise.resolve(['flow-hello-world']);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockReadFile.mockResolvedValue(
      makePackageJson('@ganderbite/flow-hello-world', '1.0.0', 'Hello world flow'),
    );

    await listCommand([], {});

    expect(stdoutOutput).toContain('hello-world');
  });

  it('[LST-014] cost and duration are rendered when relay metadata is present', async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (String(dir).includes('.relay/flows')) {
        return Promise.resolve(['my-flow']);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockReadFile.mockResolvedValue(
      makePackageJson('@ganderbite/flow-my-flow', '1.0.0', 'A flow', {
        estimatedCostUsd: 0.4,
        estimatedDurationMin: 20,
      }),
    );

    await listCommand([], {});

    expect(stdoutOutput).toContain('$0.40');
    expect(stdoutOutput).toContain('20m');
  });
});

describe('relay list — remote catalog success', () => {
  it('[LST-020] renders remote-only flows when local dirs are empty', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            name: '@ganderbite/flow-remote-only',
            version: '0.5.0',
            description: 'Only in catalog',
            relay: { displayName: 'remote-only', estimatedCostUsd: { min: 0.1, max: 0.5 } },
          },
        ]),
    });

    await listCommand([], {});

    expect(stdoutOutput).toContain('remote-only');
    expect(stdoutOutput).toContain('v0.5.0');
    // Catalog note should NOT appear when remote succeeds.
    expect(stdoutOutput).not.toContain('catalog unavailable');
  });
});
