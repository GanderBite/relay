import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { inspectClaudeAuth } from '../../../src/providers/claude/auth.js';
import { ClaudeAuthError, SubscriptionTosLeakError, ERROR_CODES } from '../../../src/errors.js';

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
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'RELAY_ALLOW_API_KEY',
  ]) {
    vi.stubEnv(key, '');
  }
}

describe('inspectClaudeAuth — per-provider TOS contracts', () => {
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
  // claude-agent-sdk truth table
  // -----------------------------------------------------------------------

  describe('providerKind: claude-agent-sdk', () => {
    it('[AUTH-SDK-001] no env at all returns ClaudeAuthError requiring ANTHROPIC_API_KEY', async () => {
      stubExecFileOk(); // should not be reached

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err).not.toBeInstanceOf(SubscriptionTosLeakError);
      expect(err.message).toBe(
        'claude-agent-sdk requires ANTHROPIC_API_KEY. Set it, or run `relay init` and choose claude-cli.',
      );
      expect(err.code).toBe(ERROR_CODES.CLAUDE_AUTH);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('[AUTH-SDK-002] ANTHROPIC_API_KEY set returns ok(api-account) with warning', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('api-account');
      expect(state.detail).toContain('ANTHROPIC_API_KEY');
      expect(state.warnings).toContain('billing to API account, not subscription');
    });

    it('[AUTH-SDK-003] CLAUDE_CODE_OAUTH_TOKEN only returns SubscriptionTosLeakError', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk(); // should not be reached

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(SubscriptionTosLeakError);
      // Subclass relationship — SubscriptionTosLeakError extends ClaudeAuthError.
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.code).toBe(ERROR_CODES.TOS_LEAK_BLOCKED);
      expect(err.code).toBe('E_TOS_LEAK_BLOCKED');
      expect(err.message).toBe(
        'subscription tokens may not be used with claude-agent-sdk. Set ANTHROPIC_API_KEY for API billing, or switch to claude-cli.',
      );
      expect(err.details?.envObserved).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('[AUTH-SDK-004] both ANTHROPIC_API_KEY and OAuth set — API key wins, no leak error', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('api-account');
      expect(state.warnings).toContain('billing to API account, not subscription');
    });

    it('[AUTH-SDK-005] cloud routing (Bedrock) bypasses both checks even with OAuth set', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('bedrock');
      expect(state.detail).toContain('Bedrock');
    });

    it('[AUTH-SDK-006] cloud routing (Vertex) reports billingSource=vertex', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('vertex');
      expect(result._unsafeUnwrap().detail).toContain('Vertex');
    });

    it('[AUTH-SDK-007] Foundry via CLAUDE_CODE_USE_FOUNDRY=1 OR ANTHROPIC_FOUNDRY_URL', async () => {
      stubExecFileOk();

      vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
      const resultA = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });
      expect(resultA.isOk()).toBe(true);
      expect(resultA._unsafeUnwrap().billingSource).toBe('foundry');
      expect(resultA._unsafeUnwrap().detail).toContain('CLAUDE_CODE_USE_FOUNDRY=1');

      vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
      vi.stubEnv('ANTHROPIC_FOUNDRY_URL', 'https://foundry.example.com');
      const resultB = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });
      expect(resultB.isOk()).toBe(true);
      expect(resultB._unsafeUnwrap().billingSource).toBe('foundry');
      expect(resultB._unsafeUnwrap().detail).toContain('ANTHROPIC_FOUNDRY_URL');
    });

    it('[AUTH-SDK-008] cloud routing + ANTHROPIC_API_KEY → cloud wins', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('bedrock');
    });
  });

  // -----------------------------------------------------------------------
  // claude-cli truth table
  // -----------------------------------------------------------------------

  describe('providerKind: claude-cli', () => {
    it('[AUTH-CLI-001] no env at all + no credentials file returns ClaudeAuthError', async () => {
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk(); // should not be reached

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err).not.toBeInstanceOf(SubscriptionTosLeakError);
      expect(err.message).toBe(
        'claude-cli requires subscription auth. Run `claude /login`, or run `relay init` and choose claude-agent-sdk.',
      );
      expect(err.code).toBe(ERROR_CODES.CLAUDE_AUTH);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('[AUTH-CLI-002] ANTHROPIC_API_KEY only (no subscription) returns ClaudeAuthError', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk(); // should not be reached

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('claude-cli requires subscription auth');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('[AUTH-CLI-003] CLAUDE_CODE_OAUTH_TOKEN set returns ok(subscription, token)', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('[AUTH-CLI-004] credentials file present (no env) returns ok(subscription, interactive)', async () => {
      mockExistsSync.mockReturnValue(true);
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('interactive');
    });

    it('[AUTH-CLI-005] both ANTHROPIC_API_KEY and OAuth set — OAuth wins, ok(subscription)', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('[AUTH-CLI-006] credentials file + ANTHROPIC_API_KEY only — credentials wins', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      mockExistsSync.mockReturnValue(true);
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('subscription');
      expect(result._unsafeUnwrap().detail).toContain('interactive');
    });

    it('[AUTH-CLI-007] cloud routing (Bedrock) bypasses subscription probe', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('bedrock');
    });

    it('[AUTH-CLI-008] cloud routing + ANTHROPIC_API_KEY → cloud wins under CLI too', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('vertex');
    });

    it('[AUTH-CLI-009] cloud routing + OAuth only — cloud wins, no leak', async () => {
      vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('foundry');
    });

    it('[AUTH-CLI-010] credentials probe checks the right path', async () => {
      let capturedPath: string | undefined;
      mockExistsSync.mockImplementation((p: string): boolean => {
        capturedPath = p;
        return true;
      });
      stubExecFileOk();

      await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(capturedPath).toBeDefined();
      expect(capturedPath).toMatch(/\.claude[\/\\]\.credentials\.json$/);
    });
  });

  // -----------------------------------------------------------------------
  // Shared binary check
  // -----------------------------------------------------------------------

  describe('shared ensureClaudeBinary probe', () => {
    it('[AUTH-BIN-001] missing claude binary returns ClaudeAuthError with install instructions (sdk path)', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      stubExecFileEnoent();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('claude command not found on PATH');
      expect(err.message).toContain('npm install -g @anthropic-ai/claude-code');
      expect(typeof err.details?.cause).toBe('string');
      expect((err.details?.cause as string).length).toBeGreaterThan(0);
    });

    it('[AUTH-BIN-002] missing claude binary returns ClaudeAuthError with install instructions (cli path)', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileEnoent();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('claude command not found on PATH');
    });

    it('[AUTH-BIN-003] empty-string ANTHROPIC_API_KEY treated as unset under sdk', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('requires ANTHROPIC_API_KEY');
    });

    it('[AUTH-BIN-004] empty-string OAuth treated as unset under cli', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
      mockExistsSync.mockReturnValue(false);
      stubExecFileOk();

      const result = await inspectClaudeAuth({ providerKind: 'claude-cli' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('requires subscription auth');
    });

    it('[AUTH-BIN-005] claude --version probe uses a filtered env', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
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

      await inspectClaudeAuth({ providerKind: 'claude-agent-sdk' });

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.PATH).toBe('/usr/bin');
      expect(capturedEnv?.HOME).toBe('/root');
      expect('SLACK_TOKEN' in (capturedEnv ?? {})).toBe(false);
    });
  });
});
