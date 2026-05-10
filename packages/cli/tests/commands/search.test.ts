/**
 * Tests for `relay search <query>` command.
 *
 * The command loads the registry (cache-first, network fallback), filters by query,
 * and prints a table. All FS and network access is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — registered before module-under-test imports.
// ---------------------------------------------------------------------------

const mockStat = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: mockStat,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  };
});

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls.
// ---------------------------------------------------------------------------

import searchCommand from '../../src/commands/search.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type RegistryEntry = {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  tags?: string[];
  tier: 'verified' | 'community';
  installCount?: number;
  relay?: {
    estimatedCostUsd?: { min: number; max: number };
    estimatedDurationMin?: { min: number; max: number };
  };
};

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: overrides.name ?? 'test-flow',
    version: overrides.version ?? '1.0.0',
    description: overrides.description ?? 'A test flow',
    tier: overrides.tier ?? 'community',
    installCount: overrides.installCount ?? 0,
    ...overrides,
  };
}

const SAMPLE_REGISTRY: RegistryEntry[] = [
  makeEntry({
    name: 'migration-planner',
    displayName: 'migration-planner',
    version: '0.3.0',
    description: 'Plan database migrations',
    tags: ['migration', 'database'],
    tier: 'verified',
    installCount: 500,
    relay: {
      estimatedCostUsd: { min: 0.2, max: 0.6 },
      estimatedDurationMin: { min: 10, max: 25 },
    },
  }),
  makeEntry({
    name: 'api-audit',
    displayName: 'api-audit',
    version: '0.1.4',
    description: 'Audit API endpoints for issues',
    tags: ['api', 'audit'],
    tier: 'community',
    installCount: 150,
  }),
  makeEntry({
    name: 'framework-port',
    displayName: 'framework-port',
    version: '0.0.2',
    description: 'Port a project to a different framework',
    tags: ['migration', 'framework'],
    tier: 'community',
    installCount: 50,
  }),
];

// Make cache appear stale so the command always fetches from network in most tests.
function stubStaleCacheAndFetch(entries: RegistryEntry[]) {
  mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(entries),
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay search — header', () => {
  it('[SCH-001] prints the brand mark in the header', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    expect(stdoutOutput).toContain('●─▶●─▶●─▶●');
  });

  it('[SCH-002] prints the query in the header', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    expect(stdoutOutput).toContain('search: migration');
  });
});

describe('relay search — match found', () => {
  it('[SCH-010] renders matching entries in the table', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    expect(stdoutOutput).toContain('migration-planner');
    expect(stdoutOutput).toContain('framework-port'); // has 'migration' tag
  });

  it('[SCH-011] non-matching entries are not rendered', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    // api-audit has no mention of "migration"
    expect(stdoutOutput).not.toContain('api-audit');
  });

  it('[SCH-012] footer shows match count and install hint', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    expect(stdoutOutput).toMatch(/\d+ matches/);
    expect(stdoutOutput).toContain('relay install');
  });

  it('[SCH-013] verified entries render the "verified" tier label', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration-planner'], {});

    expect(stdoutOutput).toContain('verified');
  });

  it('[SCH-014] community entries render the "community" tier label', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['framework-port'], {});

    expect(stdoutOutput).toContain('community');
  });

  it('[SCH-015] version is rendered with v prefix', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration-planner'], {});

    expect(stdoutOutput).toContain('v0.3.0');
  });

  it('[SCH-016] verified entries rank before community entries', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['migration'], {});

    const verifiedPos = stdoutOutput.indexOf('migration-planner');
    const communityPos = stdoutOutput.indexOf('framework-port');
    expect(verifiedPos).toBeGreaterThan(-1);
    expect(communityPos).toBeGreaterThan(-1);
    expect(verifiedPos).toBeLessThan(communityPos);
  });
});

describe('relay search — no match', () => {
  it('[SCH-020] prints "no races match" when query has no results', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand(['xyzzy-nonexistent'], {});

    expect(stdoutOutput).toContain('no races match');
    expect(stdoutOutput).toContain('xyzzy-nonexistent');
  });

  it('[SCH-021] empty query matches all entries', async () => {
    stubStaleCacheAndFetch(SAMPLE_REGISTRY);

    await searchCommand([''], {});

    // All three sample entries should appear.
    expect(stdoutOutput).toContain('migration-planner');
    expect(stdoutOutput).toContain('api-audit');
    expect(stdoutOutput).toContain('framework-port');
  });
});

describe('relay search — network failure', () => {
  it('[SCH-030] prints warning when registry is unreachable and no cache exists', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFetch.mockRejectedValue(new Error('Network unavailable'));

    await searchCommand(['anything'], {});

    expect(stdoutOutput).toContain('unable to reach catalog');
  });

  it('[SCH-031] falls back to stale cache when network fails', async () => {
    // Cache file exists but is old (stat says so by returning a mtime far in the past).
    mockStat.mockResolvedValue({
      mtimeMs: Date.now() - 2 * 3_600_000, // 2 hours ago — past the 1-hour TTL
    });
    mockReadFile.mockResolvedValue(JSON.stringify(SAMPLE_REGISTRY));
    mockFetch.mockRejectedValue(new Error('Network unavailable'));

    await searchCommand(['api-audit'], {});

    // Stale cache is returned and results are shown.
    expect(stdoutOutput).toContain('api-audit');
    expect(stdoutOutput).not.toContain('unable to reach catalog');
  });
});

describe('relay search — fresh cache', () => {
  it('[SCH-040] uses cache when it is fresh (within 1-hour TTL)', async () => {
    // Cache is fresh.
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 10_000 }); // 10s ago
    mockReadFile.mockResolvedValue(JSON.stringify(SAMPLE_REGISTRY));
    // fetch must not be called when cache is fresh.

    await searchCommand(['api-audit'], {});

    expect(mockFetch).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain('api-audit');
  });
});
