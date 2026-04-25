import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks. execFile is promisified at module init, so the mock must be
// registered before auth.ts loads. fs.existsSync is the subscription probe for
// the claude-cli branch, mocked here so tests do not depend on the developer's
// actual ~/.claude/.credentials.json file.
const mockExecFile = vi.fn();
const mockExistsSync = vi.fn<(p: string) => boolean>();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ): void => mockExecFile(cmd, args, opts, cb),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string): boolean => mockExistsSync(p),
  };
});

import { ClaudeAuthError, ERROR_CODES } from '../../../src/errors.js';
import { inspectClaudeAuth } from '../../../src/providers/claude-cli/auth.js';

function stubExecFileOk(): void {
  mockExecFile.mockImplementation(
    (_cmd, _args, _opts, cb: (e: Error | null, so: string, se: string) => void) => {
      cb(null, 'claude 2.4.1\n', '');
    },
  );
}

function stubExecFileEnoent(): void {
  mockExecFile.mockImplementation(
    (_cmd, _args, _opts, cb: (e: Error | null, so: string, se: string) => void) => {
      const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      cb(err, '', '');
    },
  );
}

function clearAllAuthEnv(): void {
  vi.unstubAllEnvs();
  for (const key of [
    'ANTHROPIC_FOUNDRY_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    vi.stubEnv(key, '');
  }
}

describe('inspectClaudeAuth — claude-cli TOS contract', () => {
  beforeEach(() => {
    clearAllAuthEnv();
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
    // Default: no credentials file. Tests that need it explicitly stub true.
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
  });

  // -----------------------------------------------------------------------
  // claude-cli truth table
  // -----------------------------------------------------------------------

  describe('claude-cli truth table', () => {
    it('[AUTH-CLI-001] no env at all, binary present → ok(subscription, interactive)', async () => {
      // Credentials are stored in the OS keychain (macOS) or by the binary
      // itself — we cannot probe them cross-platform. If the binary answers
      // `claude --version`, we trust it and let it surface auth failures at
      // invocation time with its own error message.
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('interactive');
      expect(mockExecFile).toHaveBeenCalledOnce();
    });

    it('[AUTH-CLI-003] CLAUDE_CODE_OAUTH_TOKEN set returns ok(subscription, token)', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('[AUTH-CLI-004] no oauth env, binary present → ok(subscription, interactive)', async () => {
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('interactive');
    });

    it('[AUTH-CLI-007] cloud routing (Bedrock) bypasses subscription probe', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('bedrock');
    });

    it('[AUTH-CLI-009] cloud routing + OAuth only — cloud wins, no leak', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('foundry');
    });

    it('[AUTH-CLI-010] binary missing → err(ClaudeAuthError) with install instructions', async () => {
      // When the binary is absent, auth must fail — there is nothing to run.
      stubExecFileEnoent();

      const result = await inspectClaudeAuth();

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('claude command not found on PATH');
    });
  });

  // -----------------------------------------------------------------------
  // Binary preflight probe
  // -----------------------------------------------------------------------

  describe('ensureClaudeBinary probe', () => {
    it('[AUTH-BIN-001] missing claude binary returns ClaudeAuthError with install instructions', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileEnoent();

      const result = await inspectClaudeAuth();

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('claude command not found on PATH');
      expect(err.message).toContain('npm install -g @anthropic-ai/claude-code');
      expect(typeof err.details?.cause).toBe('string');
      expect((err.details?.cause as string).length).toBeGreaterThan(0);
    });

    it('[AUTH-BIN-002] empty-string OAuth treated as unset — falls through to binary check', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
      stubExecFileOk();

      const result = await inspectClaudeAuth();

      // Empty string is not a valid token; falls through to binary trust.
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('subscription');
      expect(result._unsafeUnwrap().detail).toContain('interactive');
    });

    it('[AUTH-BIN-003] claude --version probe uses a filtered env', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      vi.stubEnv('PATH', '/usr/bin');
      vi.stubEnv('HOME', '/root');
      vi.stubEnv('SLACK_TOKEN', 'xoxb-secret-123');
      let capturedEnv: Record<string, string | undefined> | undefined;
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: readonly string[],
          opts: { env?: Record<string, string | undefined> } | undefined,
          cb: (e: Error | null, so: string, se: string) => void,
        ) => {
          capturedEnv = opts?.env;
          cb(null, 'claude 2.4.1\n', '');
        },
      );

      await inspectClaudeAuth();

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.PATH).toBe('/usr/bin');
      expect(capturedEnv?.HOME).toBe('/root');
      expect('SLACK_TOKEN' in (capturedEnv ?? {})).toBe(false);
    });
  });
});
