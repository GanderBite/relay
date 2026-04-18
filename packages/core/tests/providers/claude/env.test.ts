import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ALLOWLIST_EXACT,
  buildEnvAllowlist,
} from '../../../src/providers/claude/env.js';

describe('buildEnvAllowlist — containment contract', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('[ENV-001] forwards every ALLOWLIST_EXACT key at its real host value', () => {
    for (const key of ALLOWLIST_EXACT) {
      vi.stubEnv(key, `sentinel-${key}`);
    }

    const result = buildEnvAllowlist();

    for (const key of ALLOWLIST_EXACT) {
      expect(result[key]).toBe(`sentinel-${key}`);
    }
  });

  it('[ENV-002] always forwards CLAUDE_ prefixed variables', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
    vi.stubEnv('CLAUDE_CUSTOM', 'sentinel');

    const result = buildEnvAllowlist();

    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-xxx');
    expect(result.CLAUDE_CUSTOM).toBe('sentinel');
  });

  it('[ENV-003] suppresses ANTHROPIC_ variables as undefined when allowApiKey is false', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com');

    const result = buildEnvAllowlist();

    expect('ANTHROPIC_API_KEY' in result).toBe(true);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect('ANTHROPIC_BASE_URL' in result).toBe(true);
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('[ENV-004] forwards ANTHROPIC_ variables at real values when allowApiKey is true', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');

    const result = buildEnvAllowlist({ allowApiKey: true });

    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
  });

  it('[ENV-005] emits non-allowlisted host vars as undefined (suppression patch)', () => {
    vi.stubEnv('PATH', '/bin');
    vi.stubEnv('SLACK_TOKEN', 'xoxb-1');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_1');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('DATABASE_URL', 'postgres://example');

    const result = buildEnvAllowlist();

    expect(result.PATH).toBe('/bin');
    for (const k of ['SLACK_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) {
      expect(k in result).toBe(true);
      expect(result[k]).toBeUndefined();
    }
  });

  it('[ENV-006] caller-supplied extras override allowlist and suppression', () => {
    vi.stubEnv('PATH', '/bin');
    vi.stubEnv('TEST_VAR', 'hostvalue');

    const result = buildEnvAllowlist({
      extra: { TEST_VAR: 'stepvalue', NEW_VAR: 'fresh' },
    });

    expect(result.TEST_VAR).toBe('stepvalue');
    expect(result.NEW_VAR).toBe('fresh');
    expect(result.PATH).toBe('/bin');
  });

  it('[ENV-007] does not mutate process.env', () => {
    vi.stubEnv('FOO', 'bar');
    const before = { ...process.env };

    buildEnvAllowlist();
    buildEnvAllowlist({ allowApiKey: true });
    buildEnvAllowlist({ extra: { X: 'y' } });

    const after = { ...process.env };
    expect(after).toEqual(before);
  });

  it('[ENV-008] skips host env keys whose values are undefined (not emitted)', () => {
    const originalEnv = process.env;
    const synthetic: Record<string, string | undefined> = {
      PATH: '/bin',
      DEFINED_KEY: 'x',
      UNDEFINED_KEY: undefined,
    };
    Object.defineProperty(process, 'env', { value: synthetic, configurable: true });
    try {
      const result = buildEnvAllowlist();
      expect('UNDEFINED_KEY' in result).toBe(false);
      expect('DEFINED_KEY' in result).toBe(true);
    } finally {
      Object.defineProperty(process, 'env', { value: originalEnv, configurable: true });
    }
  });
});
