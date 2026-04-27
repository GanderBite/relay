/**
 * Tests for `relay install` command — tarball-fetch install flow.
 *
 * All I/O (filesystem, network fetch, tar extraction) is mocked. No live
 * network calls, no real npm invocations, no real disk writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockWriteFile = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockMkdir = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockStat = vi.hoisted(() => vi.fn<() => Promise<{ mtimeMs: number }>>());
const mockAccess = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockExtract = vi.hoisted(() => vi.fn());
const mockPipeline = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    access: (...args: unknown[]) => mockAccess(...args),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => '/fake-home',
  };
});

vi.mock('tar', () => ({
  extract: (...args: unknown[]) => mockExtract(...args),
}));

vi.mock('node:stream/promises', () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test after mocks are registered.
// ---------------------------------------------------------------------------

import installCommand from '../../src/commands/install.js';

// ---------------------------------------------------------------------------
// Registry JSON fixtures
// ---------------------------------------------------------------------------

const successRegistry = JSON.stringify({
  version: 1,
  flows: [
    {
      name: '@ganderbite/flow-my-flow',
      version: '0.2.0',
      dist: {
        tarball: 'https://example.com/my-flow-0.2.0.tgz',
        shasum: 'abc123',
      },
    },
  ],
});

const emptyTarballRegistry = JSON.stringify({
  version: 1,
  flows: [
    {
      name: '@ganderbite/flow-my-flow',
      version: '0.2.0',
      dist: {
        tarball: '',
        shasum: '',
      },
    },
  ],
});

const emptyRegistry = JSON.stringify({ version: 1, flows: [] });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WHATWG ReadableStream for mocking fetch body. */
function makeFakeBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Build a fetch mock that returns a successful tarball response. */
function makeTarballFetchResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: makeFakeBody(),
    text: vi.fn<() => Promise<string>>().mockResolvedValue(''),
  } as unknown as Response;
}

/** Build a fetch mock that returns a 404 response. */
function make404FetchResponse(): Response {
  return {
    ok: false,
    status: 404,
    body: null,
    text: vi.fn<() => Promise<string>>().mockResolvedValue(''),
  } as unknown as Response;
}

/** Collect all calls to a spy's write() and return them as a single string. */
function captureWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: stat throws (cache file missing) so refreshRegistryCache runs fetch.
  mockStat.mockRejectedValue(new Error('ENOENT'));

  // Default: registry fetch returns the success registry then subsequent fetches fail.
  // We'll override per-test as needed.
  const registryResponse = {
    ok: true,
    status: 200,
    body: makeFakeBody(),
    text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
  } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(registryResponse));

  // Default: readFile returns success registry for the registry.json path.
  mockReadFile.mockImplementation((filePath: unknown) => {
    const p = String(filePath);
    if (p.includes('.relay/registry.json')) {
      return Promise.resolve(successRegistry);
    }
    return Promise.reject(new Error(`ENOENT: unexpected readFile call for ${p}`));
  });

  // Default: mkdir and writeFile succeed.
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);

  // Default: pipeline resolves immediately (extraction succeeds).
  mockPipeline.mockResolvedValue(undefined);

  // Default: access throws (no dist/flow.js pre-compiled).
  mockAccess.mockRejectedValue(new Error('ENOENT'));

  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${String(code)}`);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay install — missing flow name argument', () => {
  it('[INSTALL-001] empty args array causes process.exit(1) with usage hint on stderr', async () => {
    await expect(installCommand([], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('usage: relay install <flow>[@<version>]');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('[INSTALL-002] whitespace-only arg causes process.exit(1) with usage hint on stderr', async () => {
    await expect(installCommand(['   '], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('usage: relay install <flow>[@<version>]');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay install — registry entry not found', () => {
  it('[INSTALL-003] unknown flow name exits with code 1 and stderr contains "not found in registry"', async () => {
    mockReadFile.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.includes('.relay/registry.json')) {
        return Promise.resolve(emptyRegistry);
      }
      return Promise.reject(new Error(`ENOENT: unexpected readFile call for ${p}`));
    });

    await expect(installCommand(['unknown-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('not found in registry');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('[INSTALL-004] registry readFile failure exits with code 1 and stderr contains "not found in registry"', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await expect(installCommand(['my-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('not found in registry');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay install — registry entry has empty tarball', () => {
  it('[INSTALL-005] flow with empty dist.tarball exits with code 1 and stderr contains "no published release yet"', async () => {
    mockReadFile.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.includes('.relay/registry.json')) {
        return Promise.resolve(emptyTarballRegistry);
      }
      return Promise.reject(new Error(`ENOENT: unexpected readFile call for ${p}`));
    });

    await expect(installCommand(['my-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('no published release yet');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay install — tarball fetch failure', () => {
  it('[INSTALL-006] HTTP 404 exits with code 1 and stderr contains "failed to download"', async () => {
    const fetchMock = vi.fn();
    // First call: registry refresh → returns registry JSON ok response.
    // Second call: tarball fetch → returns 404.
    const registryRefreshResponse = {
      ok: true,
      status: 200,
      body: makeFakeBody(),
      text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
    } as unknown as Response;
    fetchMock
      .mockResolvedValueOnce(registryRefreshResponse)
      .mockResolvedValueOnce(make404FetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(installCommand(['my-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('failed to download');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('[INSTALL-007] network error throws exits with code 1 and stderr contains "failed to download"', async () => {
    const fetchMock = vi.fn();
    // First call: registry refresh → ok.
    // Second call: tarball fetch → throws network error.
    const registryRefreshResponse = {
      ok: true,
      status: 200,
      body: makeFakeBody(),
      text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
    } as unknown as Response;
    fetchMock
      .mockResolvedValueOnce(registryRefreshResponse)
      .mockRejectedValueOnce(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(installCommand(['my-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('failed to download');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('relay install — successful install', () => {
  it('[INSTALL-008] fetch called with tarball URL, extract called with strip:1, stdout has resolved and unpacked lines', async () => {
    const tarballUrl = 'https://example.com/my-flow-0.2.0.tgz';

    const fetchMock = vi.fn();
    // First call: registry refresh response.
    const registryRefreshResponse = {
      ok: true,
      status: 200,
      body: makeFakeBody(),
      text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
    } as unknown as Response;
    // Second call: tarball fetch response.
    fetchMock
      .mockResolvedValueOnce(registryRefreshResponse)
      .mockResolvedValueOnce(makeTarballFetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    // pipeline resolves immediately (already set in beforeEach).
    // After extraction, installCommand tries to import dist/flow.js which will fail,
    // causing process.exit(2). We catch that and verify the pre-validation stdout output.
    let thrownError: Error | undefined;
    try {
      await installCommand(['my-flow'], {});
    } catch (err: unknown) {
      thrownError = err as Error;
    }

    // The command exits at some point (either 0 on full success, or 2 on validation failure).
    // What matters is that fetch was called with the tarball URL and stdout received the
    // resolved + unpacked lines before any exit.
    expect(fetchMock).toHaveBeenCalledWith(
      tarballUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(mockPipeline).toHaveBeenCalledOnce();
    // Verify extract was configured with strip:1
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ strip: 1 }));

    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('resolved @ganderbite/flow-my-flow@0.2.0 from registry');
    expect(stdout).toContain('unpacked to ./.relay/flows/my-flow/');

    // Either process exited or completed — in both cases the above assertions hold.
    // If it exited, the error should be exit:1 or exit:2 (validation), not a fetch error.
    if (thrownError !== undefined) {
      expect(thrownError.message).not.toContain('failed to download');
      expect(thrownError.message).not.toContain('not found in registry');
    }
  });

  it('[INSTALL-009] scoped package name is parsed and the correct bare name is used', async () => {
    const tarballUrl = 'https://example.com/my-flow-0.2.0.tgz';

    const fetchMock = vi.fn();
    const registryRefreshResponse = {
      ok: true,
      status: 200,
      body: makeFakeBody(),
      text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
    } as unknown as Response;
    fetchMock
      .mockResolvedValueOnce(registryRefreshResponse)
      .mockResolvedValueOnce(makeTarballFetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    try {
      await installCommand(['@ganderbite/flow-my-flow'], {});
    } catch {
      // may exit on validation — that is expected
    }

    expect(fetchMock).toHaveBeenCalledWith(tarballUrl, expect.any(Object));

    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('resolved @ganderbite/flow-my-flow@0.2.0 from registry');
    expect(stdout).toContain('unpacked to ./.relay/flows/my-flow/');
  });

  it('[INSTALL-010] registry cache is fresh (stat succeeds within TTL) so no registry network fetch', async () => {
    // Stat returns a very recent mtime — no refresh needed.
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 1000 });

    const fetchMock = vi.fn().mockResolvedValueOnce(makeTarballFetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    try {
      await installCommand(['my-flow'], {});
    } catch {
      // may exit on validation
    }

    // fetch should only have been called once — for the tarball, not for the registry.
    const registryFetchCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('relay.dev/registry.json'),
    );
    expect(registryFetchCalls).toHaveLength(0);

    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('resolved @ganderbite/flow-my-flow@0.2.0 from registry');
  });
});

describe('relay install — pipeline/extract failure', () => {
  it('[INSTALL-011] pipeline throw exits with code 1 and stderr contains "failed to download"', async () => {
    const fetchMock = vi.fn();
    const registryRefreshResponse = {
      ok: true,
      status: 200,
      body: makeFakeBody(),
      text: vi.fn<() => Promise<string>>().mockResolvedValue(successRegistry),
    } as unknown as Response;
    fetchMock
      .mockResolvedValueOnce(registryRefreshResponse)
      .mockResolvedValueOnce(makeTarballFetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    mockPipeline.mockRejectedValue(new Error('extraction failed'));

    await expect(installCommand(['my-flow'], {})).rejects.toThrow('exit:1');

    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('failed to download');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
