import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALLOWLIST_CLOUD_ROUTING,
  ALLOWLIST_EXACT,
  ALLOWLIST_PREFIX_CLI,
  buildEnvAllowlist,
} from '../../../src/providers/claude-cli/env.js';

describe('buildEnvAllowlist — claude-cli containment contract', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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

      const result = buildEnvAllowlist();

      for (const key of ALLOWLIST_EXACT) {
        expect(result[key]).toBe(`sentinel-${key}`);
      }
    });

    it('[ENV-COMMON-002] forwards every ALLOWLIST_CLOUD_ROUTING key at its real host value', () => {
      for (const key of ALLOWLIST_CLOUD_ROUTING) {
        vi.stubEnv(key, `cloud-${key}`);
      }

      const result = buildEnvAllowlist();

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

      const result = buildEnvAllowlist();

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
        extra: { TEST_VAR: 'stepvalue', NEW_VAR: 'fresh' },
      });

      expect(result.TEST_VAR).toBe('stepvalue');
      expect(result.NEW_VAR).toBe('fresh');
      expect(result.PATH).toBe('/bin');
    });

    it('[ENV-COMMON-005] does not mutate process.env', () => {
      vi.stubEnv('FOO', 'bar');
      const before = { ...process.env };

      buildEnvAllowlist();
      buildEnvAllowlist({ extra: { X: 'y' } });

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
        const result = buildEnvAllowlist();
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

  describe('claude-cli surface', () => {
    it('[ENV-CLI-001] forwards CLAUDE_* prefixed variables (including OAuth)', () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      vi.stubEnv('CLAUDE_CUSTOM', 'sentinel');

      const result = buildEnvAllowlist();

      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-xxx');
      expect(result.CLAUDE_CUSTOM).toBe('sentinel');
    });

    it('[ENV-CLI-002] suppresses non-allowlisted ANTHROPIC_* vars (e.g. ANTHROPIC_BASE_URL)', () => {
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com');

      const result = buildEnvAllowlist();

      // Not on any allowlist or cloud-routing list — suppressed to undefined.
      expect('ANTHROPIC_BASE_URL' in result).toBe(true);
      expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('[ENV-CLI-005] cloud-routing keys are forwarded under the CLI provider', () => {
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_FOUNDRY_URL', 'https://foundry.example.com');

      const result = buildEnvAllowlist();

      expect(result.CLAUDE_CODE_USE_VERTEX).toBe('1');
      expect(result.ANTHROPIC_FOUNDRY_URL).toBe('https://foundry.example.com');
    });

    it('[ENV-CLI-006] caller-supplied extras override suppression for any key', () => {
      vi.stubEnv('CUSTOM_SECRET', 'host-value');

      const result = buildEnvAllowlist({
        extra: { CUSTOM_SECRET: 'caller-supplied' },
      });

      expect(result.CUSTOM_SECRET).toBe('caller-supplied');
    });

    it('[ENV-CLI-007] the published prefix list is exactly CLAUDE_', () => {
      expect(ALLOWLIST_PREFIX_CLI).toEqual(['CLAUDE_']);
    });
  });
});
