import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock: execFile is promisified at module init, so mock must be registered
// before auth.ts loads. Vitest hoists vi.mock to top of file.
const mockExecFile = vi.fn();
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

import { inspectClaudeAuth } from '../../../src/providers/claude/auth.js';
import { ClaudeAuthError } from '../../../src/errors.js';

// Default stub: pretend claude --version succeeds. Individual tests override.
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

describe('inspectClaudeAuth — billing safety guard', () => {
  beforeEach(() => {
    // Clear every env var that could steer the guard. Individual tests stub what they need.
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('RELAY_ALLOW_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
    vi.stubEnv('ANTHROPIC_FOUNDRY_URL', '');
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExecFile.mockReset();
  });

  it('[AUTH-001] blocks run when ANTHROPIC_API_KEY is set without opt-in', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    stubExecFileOk(); // should not be reached

    const result = await inspectClaudeAuth();

    expect(result.isErr()).toBe(true);
    const err = result._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(ClaudeAuthError);
    expect(err.message).toContain('RELAY_ALLOW_API_KEY');
    expect(err.message).toContain('runner.allowApiKey()');
    expect(err.details?.envObserved).toContain('ANTHROPIC_API_KEY');
    expect(err.details?.billingSource).toBe('api-account');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('[AUTH-002] allows run when ANTHROPIC_API_KEY + RELAY_ALLOW_API_KEY=1 and warns', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    vi.stubEnv('RELAY_ALLOW_API_KEY', '1');
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    const state = result._unsafeUnwrap();
    expect(state.ok).toBe(true);
    expect(state.billingSource).toBe('api-account');
    expect(state.detail).toContain('RELAY_ALLOW_API_KEY');
    expect(state.warnings).toContain('billing to API account, not subscription');
  });

  it('[AUTH-003] allows run when allowApiKey option is true', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    stubExecFileOk();

    const result = await inspectClaudeAuth({ allowApiKey: true });

    expect(result.isOk()).toBe(true);
    const state = result._unsafeUnwrap();
    expect(state.billingSource).toBe('api-account');
    expect(state.detail).toContain('runner.allowApiKey()');
    expect(state.warnings).toContain('billing to API account, not subscription');
  });

  it('[AUTH-004] cloud routing (Bedrock) bypasses the API-key guard', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    const state = result._unsafeUnwrap();
    expect(state.billingSource).toBe('bedrock');
    expect(state.detail).toContain('Bedrock');
    expect(state.detail).toContain('CLAUDE_CODE_USE_BEDROCK=1');
  });

  it('[AUTH-005] cloud routing (Vertex) reports billingSource=vertex', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().billingSource).toBe('vertex');
    expect(result._unsafeUnwrap().detail).toContain('Vertex');
  });

  it('[AUTH-006] Foundry via CLAUDE_CODE_USE_FOUNDRY=1 OR ANTHROPIC_FOUNDRY_URL', async () => {
    stubExecFileOk();

    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
    const resultA = await inspectClaudeAuth();
    expect(resultA.isOk()).toBe(true);
    expect(resultA._unsafeUnwrap().billingSource).toBe('foundry');
    expect(resultA._unsafeUnwrap().detail).toContain('CLAUDE_CODE_USE_FOUNDRY=1');

    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
    vi.stubEnv('ANTHROPIC_FOUNDRY_URL', 'https://foundry.example.com');
    const resultB = await inspectClaudeAuth();
    expect(resultB.isOk()).toBe(true);
    expect(resultB._unsafeUnwrap().billingSource).toBe('foundry');
    expect(resultB._unsafeUnwrap().detail).toContain('ANTHROPIC_FOUNDRY_URL');
  });

  it('[AUTH-007] CLAUDE_CODE_OAUTH_TOKEN reports subscription (token mode)', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().billingSource).toBe('subscription');
    expect(result._unsafeUnwrap().detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('[AUTH-008] no auth env vars falls back to interactive subscription', async () => {
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().billingSource).toBe('subscription');
    expect(result._unsafeUnwrap().detail).toContain('interactive');
  });

  it('[AUTH-009] missing claude binary returns ClaudeAuthError with install instructions', async () => {
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

  it('[AUTH-010] empty-string ANTHROPIC_API_KEY is treated as unset', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    stubExecFileOk();

    const result = await inspectClaudeAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().billingSource).toBe('subscription');
  });

  it('[AUTH-011] claude --version probe uses a filtered env, not full inherited env', async () => {
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
