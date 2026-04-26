/**
 * Tests for `relay doctor` command.
 *
 * The doctor command probes the environment and emits a structured status
 * report. All external dependencies (claude binary, settings loaders, provider
 * authenticate()) are mocked so the test suite is deterministic and offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before module-under-test imports.
// ---------------------------------------------------------------------------

const mockCliAuthenticate = vi.hoisted(() => vi.fn());
const mockRegisterDefaultProviders = vi.hoisted(() => vi.fn());
const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockLoadFlowSettings = vi.hoisted(() => vi.fn());
const mockResolveProvider = vi.hoisted(() => vi.fn());

vi.mock('@ganderbite/relay-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ganderbite/relay-core')>();

  const mockCli = {
    name: 'claude-cli',
    capabilities: {},
    authenticate: mockCliAuthenticate,
  };

  // defaultRegistry.list() returns the single registered provider.
  const mockRegistry = {
    list: () => [mockCli],
    register: vi.fn(),
    registerIfAbsent: vi.fn(),
    get: vi.fn(),
    has: vi.fn(),
  };

  return {
    ...actual,
    defaultRegistry: mockRegistry,
    registerDefaultProviders: mockRegisterDefaultProviders,
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    loadFlowSettings: (_dir: string) => mockLoadFlowSettings(_dir),
    resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
    NoProviderConfiguredError: actual.NoProviderConfiguredError,
  };
});

// Mock execFile so `claude --version` and `which claude` never run real binaries.
// The promisify.custom symbol is required so that `promisify(execFile)` inside
// doctor.ts receives { stdout, stderr } objects instead of a plain string.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');

  function execFileMockWrapper(
    _cmd: string,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void {
    execFileMock(_cmd, _args, _opts, cb);
  }

  // Attach a custom promisify handler so promisify(execFile) in doctor.ts
  // resolves with { stdout, stderr } as the real execFile does.
  (execFileMockWrapper as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFileMock(cmd, args, opts, (e: Error | null, stdout: string, stderr: string) => {
        if (e) reject(e);
        else resolve({ stdout, stderr });
      });
    });

  return {
    ...actual,
    execFile: execFileMockWrapper,
  };
});

// Mock fs/promises.mkdir and fs/promises.access for the .relay dir check.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  };
});

import { err, NoProviderConfiguredError, ok } from '@ganderbite/relay-core';
import doctorCommand from '../../src/commands/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authOk(billingSource: string) {
  return ok({
    ok: true,
    billingSource,
    detail: `${billingSource} (test)`,
  });
}

function stubClaudeBinaryOk(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (e: Error | null, so: string, se: string) => void,
    ) => {
      if (String(args[0]) === '--version') {
        cb(null, 'claude 2.4.1\n', '');
        return;
      }
      if (_cmd === 'which') {
        cb(null, '/usr/local/bin/claude\n', '');
        return;
      }
      cb(null, '', '');
    },
  );
}

function stubClaudeBinaryMissing(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: unknown,
      _opts: unknown,
      cb: (e: Error | null, so: string, se: string) => void,
    ) => {
      const e = Object.assign(new Error('not found'), { code: 'ENOENT' });
      cb(e, '', '');
    },
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stdoutOutput: string;
let _stderrOutput: string;

beforeEach(() => {
  stdoutOutput = '';
  _stderrOutput = '';

  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutOutput += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    _stderrOutput += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  // Default: claude binary OK, provider auth OK, resolver finds claude-cli from global.
  stubClaudeBinaryOk();
  mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
  mockLoadGlobalSettings.mockResolvedValue(ok({ provider: 'claude-cli' }));
  mockLoadFlowSettings.mockResolvedValue(ok(null));
  mockResolveProvider.mockReturnValue(
    ok({ name: 'claude-cli', capabilities: {}, authenticate: mockCliAuthenticate }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  mockCliAuthenticate.mockReset();
  mockLoadGlobalSettings.mockReset();
  mockLoadFlowSettings.mockReset();
  mockResolveProvider.mockReset();
  mockRegisterDefaultProviders.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay doctor', () => {
  describe('providers block', () => {
    it('[DOCTOR-001] lists claude-cli with subscription-safe billing descriptor', async () => {
      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      expect(stdoutOutput).toContain('claude-cli');
      expect(stdoutOutput).toContain('subscription-safe');
    });
  });

  describe('auth block', () => {
    it('[DOCTOR-003] shows per-provider authenticate probe results', async () => {
      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      expect(stdoutOutput).toContain('auth');
    });

    it('[DOCTOR-004] shows subscription ready for claude-cli when auth ok', async () => {
      mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      expect(stdoutOutput).toContain('subscription ready');
    });
  });

  describe('resolver block', () => {
    it('[DOCTOR-006] shows "resolves to: claude-cli (global-settings)" when resolver succeeds', async () => {
      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      expect(stdoutOutput).toContain('resolves to: claude-cli');
      expect(stdoutOutput).toContain('global-settings');
    });

    it('[DOCTOR-007] shows NoProviderConfiguredError message when no provider configured', async () => {
      mockResolveProvider.mockReturnValue(err(new NoProviderConfiguredError()));
      mockLoadGlobalSettings.mockResolvedValue(ok(null));

      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      // The NoProviderConfiguredError remediation message should appear.
      expect(stdoutOutput).toContain('no provider configured');
    });
  });

  describe('exit codes', () => {
    it('[DOCTOR-010] exits 0 when all checks pass', async () => {
      const exitSpy = vi.mocked(process.exit);

      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('[DOCTOR-012] exits 1 when non-API-key blockers are present', async () => {
      // Simulate missing claude binary (claude check fails).
      stubClaudeBinaryMissing();

      const exitSpy = vi.mocked(process.exit);

      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('header', () => {
    it('[DOCTOR-013] prints the relay mark and "relay doctor" header', async () => {
      await expect(doctorCommand([], {})).rejects.toThrow('process.exit called');
      expect(stdoutOutput).toContain('●─▶●─▶●─▶●');
      expect(stdoutOutput).toContain('relay doctor');
    });
  });
});
