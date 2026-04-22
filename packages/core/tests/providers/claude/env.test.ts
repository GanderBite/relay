import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ALLOWLIST_CLOUD_ROUTING,
  ALLOWLIST_EXACT,
  ALLOWLIST_PREFIX_AGENT_SDK,
  ALLOWLIST_PREFIX_CLI,
  buildEnvAllowlist,
} from '../../../src/providers/claude/env.js';

describe('buildEnvAllowlist — per-provider containment contract', () => {
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
  // Shared invariants — both providers
  // -----------------------------------------------------------------------

  describe('shared invariants', () => {
    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-001/%s] forwards every ALLOWLIST_EXACT key at its real host value',
      (providerKind) => {
        for (const key of ALLOWLIST_EXACT) {
          vi.stubEnv(key, `sentinel-${key}`);
        }

        const result = buildEnvAllowlist({ providerKind });

        for (const key of ALLOWLIST_EXACT) {
          expect(result[key]).toBe(`sentinel-${key}`);
        }
      },
    );

    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-002/%s] forwards every ALLOWLIST_CLOUD_ROUTING key at its real host value',
      (providerKind) => {
        for (const key of ALLOWLIST_CLOUD_ROUTING) {
          vi.stubEnv(key, `cloud-${key}`);
        }

        const result = buildEnvAllowlist({ providerKind });

        for (const key of ALLOWLIST_CLOUD_ROUTING) {
          expect(result[key]).toBe(`cloud-${key}`);
        }
      },
    );

    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-003/%s] emits non-allowlisted host vars as undefined (suppression patch)',
      (providerKind) => {
        vi.stubEnv('PATH', '/bin');
        vi.stubEnv('SLACK_TOKEN', 'xoxb-1');
        vi.stubEnv('GITHUB_TOKEN', 'ghp_1');
        vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
        vi.stubEnv('DATABASE_URL', 'postgres://example');

        const result = buildEnvAllowlist({ providerKind });

        expect(result.PATH).toBe('/bin');
        for (const k of ['SLACK_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) {
          expect(k in result).toBe(true);
          expect(result[k]).toBeUndefined();
        }
      },
    );

    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-004/%s] caller-supplied extras override allowlist and suppression',
      (providerKind) => {
        vi.stubEnv('PATH', '/bin');
        vi.stubEnv('TEST_VAR', 'hostvalue');

        const result = buildEnvAllowlist({
          providerKind,
          extra: { TEST_VAR: 'stepvalue', NEW_VAR: 'fresh' },
        });

        expect(result.TEST_VAR).toBe('stepvalue');
        expect(result.NEW_VAR).toBe('fresh');
        expect(result.PATH).toBe('/bin');
      },
    );

    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-005/%s] does not mutate process.env',
      (providerKind) => {
        vi.stubEnv('FOO', 'bar');
        const before = { ...process.env };

        buildEnvAllowlist({ providerKind });
        buildEnvAllowlist({ providerKind, extra: { X: 'y' } });

        const after = { ...process.env };
        expect(after).toEqual(before);
      },
    );

    it.each(['claude-agent-sdk', 'claude-cli'] as const)(
      '[ENV-COMMON-006/%s] skips host env keys whose values are undefined (not emitted)',
      (providerKind) => {
        const originalEnv = process.env;
        const synthetic: Record<string, string | undefined> = {
          PATH: '/bin',
          DEFINED_KEY: 'x',
          UNDEFINED_KEY: undefined,
        };
        Object.defineProperty(process, 'env', { value: synthetic, configurable: true });
        try {
          const result = buildEnvAllowlist({ providerKind });
          expect('UNDEFINED_KEY' in result).toBe(false);
          expect('DEFINED_KEY' in result).toBe(true);
        } finally {
          Object.defineProperty(process, 'env', { value: originalEnv, configurable: true });
        }
      },
    );
  });

  // -----------------------------------------------------------------------
  // claude-agent-sdk surface
  // -----------------------------------------------------------------------

  describe('providerKind: claude-agent-sdk', () => {
    it('[ENV-SDK-001] forwards ANTHROPIC_* prefixed variables', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com');

      const result = buildEnvAllowlist({ providerKind: 'claude-agent-sdk' });

      expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
      expect(result.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
    });

    it('[ENV-SDK-002] suppresses CLAUDE_CODE_OAUTH_TOKEN even when host has it set', () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');

      const result = buildEnvAllowlist({ providerKind: 'claude-agent-sdk' });

      expect('CLAUDE_CODE_OAUTH_TOKEN' in result).toBe(true);
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('[ENV-SDK-003] emits CLAUDE_CODE_OAUTH_TOKEN=undefined sentinel even when host did NOT set it', () => {
      // Verifies the patch is complete on its own — no need to read process.env
      // downstream to know the suppression is active.
      const result = buildEnvAllowlist({ providerKind: 'claude-agent-sdk' });

      expect('CLAUDE_CODE_OAUTH_TOKEN' in result).toBe(true);
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('[ENV-SDK-004] suppresses generic CLAUDE_* prefix vars (only OAuth via prefix is intentional, but cloud-routing exact keys still pass)', () => {
      // Generic CLAUDE_FOO is not in the allowlist for the SDK provider.
      vi.stubEnv('CLAUDE_FOO', 'leak');

      const result = buildEnvAllowlist({ providerKind: 'claude-agent-sdk' });

      expect('CLAUDE_FOO' in result).toBe(true);
      expect(result.CLAUDE_FOO).toBeUndefined();
    });

    it('[ENV-SDK-005] cloud-routing keys are forwarded under the SDK provider', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');

      const result = buildEnvAllowlist({ providerKind: 'claude-agent-sdk' });

      expect(result.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    });

    it('[ENV-SDK-006] caller can re-inject CLAUDE_CODE_OAUTH_TOKEN via extra (escape hatch)', () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-token');

      const result = buildEnvAllowlist({
        providerKind: 'claude-agent-sdk',
        extra: { CLAUDE_CODE_OAUTH_TOKEN: 'caller-supplied' },
      });

      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('caller-supplied');
    });

    it('[ENV-SDK-007] the published prefix list is exactly ANTHROPIC_', () => {
      expect(ALLOWLIST_PREFIX_AGENT_SDK).toEqual(['ANTHROPIC_']);
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
