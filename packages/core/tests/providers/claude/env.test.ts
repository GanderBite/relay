import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALLOWLIST_CLOUD_ROUTING,
  ALLOWLIST_EXACT,
  ALLOWLIST_PREFIX_CLI,
  buildEnvAllowlist,
} from '../../../src/providers/claude/env.js';

describe('buildEnvAllowlist — claude-cli containment contract', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Clear the two TOS-leak surfaces so each test starts from a known floor.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -----------------------------------------------------------------------
  // Shared invariants
  // -----------------------------------------------------------------------

  describe('shared invariants', () => {
    it('[ENV-COMMON-001] forwards every ALLOWLIST_EXACT key at its real host value', () => {
      for (const key of ALLOWLIST_EXACT) {
        vi.stubEnv(key, `sentinel-${key}`);
      }

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      for (const key of ALLOWLIST_EXACT) {
        expect(result[key]).toBe(`sentinel-${key}`);
      }
    });

    it('[ENV-COMMON-002] forwards every ALLOWLIST_CLOUD_ROUTING key at its real host value', () => {
      for (const key of ALLOWLIST_CLOUD_ROUTING) {
        vi.stubEnv(key, `cloud-${key}`);
      }

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      for (const key of ALLOWLIST_CLOUD_ROUTING) {
        expect(result[key]).toBe(`cloud-${key}`);
      }
    });

    it('[ENV-COMMON-003] emits non-allowlisted host vars as undefined (suppression patch)', () => {
      vi.stubEnv('PATH', '/bin');
      vi.stubEnv('SLACK_TOKEN', 'xoxb-1');
      vi.stubEnv('GITHUB_TOKEN', 'ghp_1');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
      vi.stubEnv('DATABASE_URL', 'postgres://example');

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      expect(result.PATH).toBe('/bin');
      for (const k of ['SLACK_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) {
        expect(k in result).toBe(true);
        expect(result[k]).toBeUndefined();
      }
    });

    it('[ENV-COMMON-004] caller-supplied extras override allowlist and suppression', () => {
      vi.stubEnv('PATH', '/bin');
      vi.stubEnv('TEST_VAR', 'hostvalue');

      const result = buildEnvAllowlist({
        providerKind: 'claude-cli',
        extra: { TEST_VAR: 'stepvalue', NEW_VAR: 'fresh' },
      });

      expect(result.TEST_VAR).toBe('stepvalue');
      expect(result.NEW_VAR).toBe('fresh');
      expect(result.PATH).toBe('/bin');
    });

    it('[ENV-COMMON-005] does not mutate process.env', () => {
      vi.stubEnv('FOO', 'bar');
      const before = { ...process.env };

      buildEnvAllowlist({ providerKind: 'claude-cli' });
      buildEnvAllowlist({ providerKind: 'claude-cli', extra: { X: 'y' } });

      const after = { ...process.env };
      expect(after).toEqual(before);
    });

    it('[ENV-COMMON-006] skips host env keys whose values are undefined (not emitted)', () => {
      const originalEnv = process.env;
      const synthetic: Record<string, string | undefined> = {
        PATH: '/bin',
        DEFINED_KEY: 'x',
        UNDEFINED_KEY: undefined,
      };
      Object.defineProperty(process, 'env', { value: synthetic, configurable: true });
      try {
        const result = buildEnvAllowlist({ providerKind: 'claude-cli' });
        expect('UNDEFINED_KEY' in result).toBe(false);
        expect('DEFINED_KEY' in result).toBe(true);
      } finally {
        Object.defineProperty(process, 'env', { value: originalEnv, configurable: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // claude-cli surface
  // -----------------------------------------------------------------------

  describe('providerKind: claude-cli', () => {
    it('[ENV-CLI-001] forwards CLAUDE_* prefixed variables (including OAuth)', () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      vi.stubEnv('CLAUDE_CUSTOM', 'sentinel');

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-xxx');
      expect(result.CLAUDE_CUSTOM).toBe('sentinel');
    });

    it('[ENV-CLI-002] suppresses ANTHROPIC_API_KEY even when host has it set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      expect('ANTHROPIC_API_KEY' in result).toBe(true);
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('[ENV-CLI-003] emits ANTHROPIC_API_KEY=undefined sentinel even when host did NOT set it', () => {
      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      expect('ANTHROPIC_API_KEY' in result).toBe(true);
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('[ENV-CLI-004] forwards other ANTHROPIC_* vars (only ANTHROPIC_API_KEY is the suppressed surface)', () => {
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com');

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      // ANTHROPIC_BASE_URL is not on the CLI prefix list and not a cloud
      // routing key, so it is suppressed.
      expect('ANTHROPIC_BASE_URL' in result).toBe(true);
      expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('[ENV-CLI-005] cloud-routing keys are forwarded under the CLI provider', () => {
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_FOUNDRY_URL', 'https://foundry.example.com');

      const result = buildEnvAllowlist({ providerKind: 'claude-cli' });

      expect(result.CLAUDE_CODE_USE_VERTEX).toBe('1');
      expect(result.ANTHROPIC_FOUNDRY_URL).toBe('https://foundry.example.com');
    });

    it('[ENV-CLI-006] caller can re-inject ANTHROPIC_API_KEY via extra (escape hatch)', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');

      const result = buildEnvAllowlist({
        providerKind: 'claude-cli',
        extra: { ANTHROPIC_API_KEY: 'caller-supplied' },
      });

      expect(result.ANTHROPIC_API_KEY).toBe('caller-supplied');
    });

    it('[ENV-CLI-007] the published prefix list is exactly CLAUDE_', () => {
      expect(ALLOWLIST_PREFIX_CLI).toEqual(['CLAUDE_']);
    });
  });
});
