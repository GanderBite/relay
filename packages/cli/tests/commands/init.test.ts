/**
 * Tests for `relay init` command.
 *
 * The init command writes ~/.relay/settings.json after probing provider auth.
 * All I/O (filesystem, stdin, child_process.spawn) is mocked. No live Claude
 * calls, no real disk writes.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist and install mocks before any module-under-test imports resolve.
// ---------------------------------------------------------------------------

// Mock @relay/core's ClaudeCliProvider and ClaudeAgentSdkProvider authenticate()
// so we control what auth returns without spawning the real binary.
const mockCliAuthenticate = vi.hoisted(() => vi.fn());
const mockSdkAuthenticate = vi.hoisted(() => vi.fn());
const mockSpawnAttached = vi.hoisted(() => vi.fn());
const mockGlobalSettingsPath = vi.hoisted(() => vi.fn<() => string>());
const mockLoadGlobalSettings = vi.hoisted(() => vi.fn());
const mockAtomicWriteJson = vi.hoisted(() => vi.fn());

// Mock spawn (for the claude /login subprocess).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => mockSpawnAttached(...args),
  };
});

vi.mock('@relay/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relay/core')>();
  return {
    ...actual,
    ClaudeCliProvider: class MockCli {
      name = 'claude-cli';
      capabilities = {};
      authenticate = mockCliAuthenticate;
    },
    ClaudeAgentSdkProvider: class MockSdk {
      name = 'claude-agent-sdk';
      capabilities = {};
      authenticate = mockSdkAuthenticate;
    },
    globalSettingsPath: () => mockGlobalSettingsPath(),
    loadGlobalSettings: () => mockLoadGlobalSettings(),
    atomicWriteJson: (...args: unknown[]) => mockAtomicWriteJson(...args),
  };
});

// Mock readline so we can inject synthetic answers without a real TTY.
const rlMock = vi.hoisted(() => ({
  question: vi.fn(),
  close: vi.fn(),
  once: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: () => rlMock,
}));

// Mock node:fs/promises.mkdir so we don't touch the real home dir.
const mkdirMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => mkdirMock(...args),
  };
});

import { ok, err, ClaudeAuthError, SubscriptionTosLeakError } from '@relay/core';
import initCommand from '../../src/commands/init.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub the readline question() to return a synthetic answer, then close. */
function stubReadline(answer: string): void {
  rlMock.question.mockImplementation(
    (_question: string, cb: (answer: string) => void) => {
      cb(answer);
    },
  );
  rlMock.once.mockImplementation((_event: string, _cb: () => void) => {
    // no-op
  });
}

/** Stub process.exit so the test can assert the exit code without actually exiting. */
function stubExit(): ReturnType<typeof vi.fn> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  return exitSpy;
}

/** Stub process.stdout.write and process.stderr.write to capture output. */
function stubOutput(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    stderr.push(String(s));
    return true;
  });
  return { stdout, stderr };
}

/** Build the auth state ok value for a subscription-billed provider. */
function authOk(billingSource = 'subscription') {
  return ok({
    ok: true,
    billingSource,
    detail: `${billingSource} (test)`,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let settingsPath: string;
let settingsDir: string;

beforeEach(async () => {
  // Point globalSettingsPath() to a temp directory so we never touch ~/.relay.
  settingsDir = await mkdtemp(join(tmpdir(), 'relay-init-test-'));
  settingsPath = join(settingsDir, 'settings.json');

  mockGlobalSettingsPath.mockReturnValue(settingsPath);
  mockLoadGlobalSettings.mockResolvedValue(ok(null));
  mockAtomicWriteJson.mockResolvedValue(ok(undefined));
  mkdirMock.mockResolvedValue(undefined);

  // Default: auth succeeds.
  mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
  mockSdkAuthenticate.mockResolvedValue(authOk('api-account'));

  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(settingsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  rlMock.question.mockReset();
  rlMock.once.mockReset();
  mockCliAuthenticate.mockReset();
  mockSdkAuthenticate.mockReset();
  mockAtomicWriteJson.mockReset();
  mockSpawnAttached.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay init', () => {
  describe('--provider claude-cli (non-interactive) + auth OK', () => {
    it('[INIT-001] writes settings on auth-ok and exits 0', async () => {
      mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
      mockAtomicWriteJson.mockResolvedValue(ok(undefined));

      await initCommand([], { provider: 'claude-cli' });

      expect(mockAtomicWriteJson).toHaveBeenCalledWith(
        settingsPath,
        { provider: 'claude-cli' },
      );
    });
  });

  describe('--provider claude-agent-sdk + SubscriptionTosLeakError', () => {
    it('[INIT-002] surfaces TOS-leak error, no settings written, process exits non-zero', async () => {
      const tosError = new SubscriptionTosLeakError(
        'subscription tokens may not be used with claude-agent-sdk.',
      );
      mockSdkAuthenticate.mockResolvedValue(err(tosError));

      await expect(
        initCommand([], { provider: 'claude-agent-sdk' }),
      ).rejects.toThrow('process.exit called');

      // The TOS error message must be surfaced.
      const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrCalls).toContain('subscription tokens may not be used');

      // settings must NOT be written.
      expect(mockAtomicWriteJson).not.toHaveBeenCalled();
    });
  });

  describe('--provider claude-cli + not logged in + answers Y', () => {
    it('[INIT-003] spawns claude /login, re-probes OK, writes settings', async () => {
      const authError = new ClaudeAuthError(
        'claude-cli requires subscription auth. Run `claude /login`.',
      );
      // First probe fails, second succeeds.
      mockCliAuthenticate
        .mockResolvedValueOnce(err(authError))
        .mockResolvedValueOnce(authOk('subscription'));

      // Stub readline to say 'Y' for the "run `claude /login` now?" prompt.
      stubReadline('Y');

      // Make mockSpawnAttached return a child-like object that exits cleanly.
      const mockChild = {
        on: vi.fn((event: string, cb: (code: number | null, signal: string | null) => void) => {
          if (event === 'close') {
            // Simulate the login exiting with code 0.
            setImmediate(() => cb(0, null));
          }
        }),
      };
      mockSpawnAttached.mockReturnValue(mockChild);

      await initCommand([], { provider: 'claude-cli' });

      // Confirm spawn was called for `claude /login`.
      expect(mockSpawnAttached).toHaveBeenCalledWith(
        'claude',
        ['/login'],
        expect.objectContaining({ stdio: 'inherit' }),
      );

      // After re-probe succeeds, settings must be written.
      expect(mockAtomicWriteJson).toHaveBeenCalledWith(
        settingsPath,
        { provider: 'claude-cli' },
      );
    });
  });

  describe('--provider claude-cli + not logged in + answers N', () => {
    it('[INIT-004] prints redirect message, exits non-zero without writing settings', async () => {
      const authError = new ClaudeAuthError(
        'claude-cli requires subscription auth. Run `claude /login`.',
      );
      mockCliAuthenticate.mockResolvedValue(err(authError));

      // Stub readline to say 'n'.
      stubReadline('n');

      await expect(
        initCommand([], { provider: 'claude-cli' }),
      ).rejects.toThrow('process.exit called');

      const stdoutCalls = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stdoutCalls).toContain('claude /login');

      // No settings written.
      expect(mockAtomicWriteJson).not.toHaveBeenCalled();
    });
  });

  describe('--force flag with existing settings', () => {
    it('[INIT-005] overwrites without prompt when --force is passed', async () => {
      // Simulate existing settings with a different provider.
      mockLoadGlobalSettings.mockResolvedValue(
        ok({ provider: 'claude-agent-sdk' }),
      );
      mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
      mockAtomicWriteJson.mockResolvedValue(ok(undefined));

      // --force + --provider: should NOT prompt the user.
      await initCommand([], { provider: 'claude-cli', force: true });

      // Confirm settings were overwritten.
      expect(mockAtomicWriteJson).toHaveBeenCalledWith(
        settingsPath,
        { provider: 'claude-cli' },
      );

      // Readline should not have been called for an overwrite confirmation.
      expect(rlMock.question).not.toHaveBeenCalled();
    });
  });

  describe('unknown provider name', () => {
    it('[INIT-006] prints error and exits non-zero', async () => {
      await expect(
        initCommand([], { provider: 'made-up-provider' }),
      ).rejects.toThrow('process.exit called');

      const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrCalls).toContain('unknown provider');
    });
  });

  describe('interactive mode — provider selection', () => {
    it('[INIT-007] choice "1" selects claude-cli', async () => {
      mockCliAuthenticate.mockResolvedValue(authOk('subscription'));
      mockAtomicWriteJson.mockResolvedValue(ok(undefined));

      stubReadline('1');

      await initCommand([], {});

      expect(mockAtomicWriteJson).toHaveBeenCalledWith(
        settingsPath,
        { provider: 'claude-cli' },
      );
    });

    it('[INIT-008] choice "2" selects claude-agent-sdk', async () => {
      mockSdkAuthenticate.mockResolvedValue(authOk('api-account'));
      mockAtomicWriteJson.mockResolvedValue(ok(undefined));

      stubReadline('2');

      await initCommand([], {});

      expect(mockAtomicWriteJson).toHaveBeenCalledWith(
        settingsPath,
        { provider: 'claude-agent-sdk' },
      );
    });

    it('[INIT-009] invalid choice exits non-zero', async () => {
      stubReadline('99');

      await expect(initCommand([], {})).rejects.toThrow('process.exit called');

      const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrCalls).toContain('invalid selection');
    });
  });
});
