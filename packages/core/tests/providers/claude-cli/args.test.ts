import { describe, it, expect } from 'vitest';

import { buildCliArgs } from '../../../src/providers/claude-cli/args.js';
import type { ClaudeCliProviderOptions } from '../../../src/providers/claude-cli/args.js';
import type { InvocationRequest } from '../../../src/providers/types.js';

const FIXED_PREFIX = [
  '-p',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--input-format',
  'text',
  '--no-session-persistence',
  '--verbose',
];

const emptyOpts: ClaudeCliProviderOptions = {};

describe('buildCliArgs', () => {
  describe('empty request', () => {
    it('returns fixed prefix only when no optional fields are set', () => {
      const req: InvocationRequest = { prompt: 'hello' };
      expect(buildCliArgs(req, emptyOpts)).toEqual(FIXED_PREFIX);
    });
  });

  describe('conditional flags in isolation', () => {
    it('appends --model when req.model is set', () => {
      const req: InvocationRequest = { prompt: 'p', model: 'claude-sonnet-4-6' };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).toContain('--model');
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('claude-sonnet-4-6');
    });

    it('appends --system-prompt when req.systemPrompt is set', () => {
      const req: InvocationRequest = { prompt: 'p', systemPrompt: 'You are helpful.' };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).toContain('--system-prompt');
      const idx = args.indexOf('--system-prompt');
      expect(args[idx + 1]).toBe('You are helpful.');
    });

    it('appends --allowedTools when req.tools is non-empty', () => {
      const req: InvocationRequest = { prompt: 'p', tools: ['Read', 'Write'] };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).toContain('--allowedTools');
      const idx = args.indexOf('--allowedTools');
      expect(args[idx + 1]).toBe('Read Write');
    });

    it('appends --json-schema when req.jsonSchema is set', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const req: InvocationRequest = { prompt: 'p', jsonSchema: schema };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).toContain('--json-schema');
      const idx = args.indexOf('--json-schema');
      expect(args[idx + 1]).toBe(JSON.stringify(schema));
    });

    it('appends --max-budget-usd when req.maxBudgetUsd is set', () => {
      const req: InvocationRequest = { prompt: 'p', maxBudgetUsd: 0.5 };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).toContain('--max-budget-usd');
      const idx = args.indexOf('--max-budget-usd');
      expect(args[idx + 1]).toBe('0.5');
    });
  });

  describe('combined flags', () => {
    it('emits all conditional flags together when all optional fields are set', () => {
      const schema = { type: 'object' };
      const req: InvocationRequest = {
        prompt: 'p',
        model: 'sonnet',
        systemPrompt: 'Be concise.',
        tools: ['Bash', 'Read'],
        jsonSchema: schema,
        maxBudgetUsd: 1.0,
      };
      const args = buildCliArgs(req, emptyOpts);

      expect(args).toContain('--model');
      expect(args).toContain('--system-prompt');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('--json-schema');
      expect(args).toContain('--max-budget-usd');
    });

    it('starts with the fixed prefix when all optional fields are set', () => {
      const req: InvocationRequest = {
        prompt: 'p',
        model: 'haiku',
        systemPrompt: 'sys',
        tools: ['Grep'],
        jsonSchema: { type: 'object' },
        maxBudgetUsd: 2,
      };
      const args = buildCliArgs(req, emptyOpts);
      expect(args.slice(0, FIXED_PREFIX.length)).toEqual(FIXED_PREFIX);
    });
  });

  describe('allowedTools space-join', () => {
    it('joins a single tool without trailing space', () => {
      const req: InvocationRequest = { prompt: 'p', tools: ['Read'] };
      const args = buildCliArgs(req, emptyOpts);
      const idx = args.indexOf('--allowedTools');
      expect(args[idx + 1]).toBe('Read');
    });

    it('joins multiple tools with a single space between each', () => {
      const req: InvocationRequest = { prompt: 'p', tools: ['Read', 'Write', 'Edit'] };
      const args = buildCliArgs(req, emptyOpts);
      const idx = args.indexOf('--allowedTools');
      expect(args[idx + 1]).toBe('Read Write Edit');
    });

    it('omits --allowedTools when tools array is empty', () => {
      const req: InvocationRequest = { prompt: 'p', tools: [] };
      const args = buildCliArgs(req, emptyOpts);
      expect(args).not.toContain('--allowedTools');
    });
  });

  describe('json-schema serialization', () => {
    it('serializes a nested schema to a JSON string', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['count'],
      };
      const req: InvocationRequest = { prompt: 'p', jsonSchema: schema };
      const args = buildCliArgs(req, emptyOpts);
      const idx = args.indexOf('--json-schema');
      const rawSchema = args[idx + 1];
      expect(rawSchema).toBeDefined();
      expect(JSON.parse(rawSchema ?? '')).toEqual(schema);
    });
  });

  describe('negative assertions', () => {
    it('never produces --bare', () => {
      const req: InvocationRequest = {
        prompt: 'p',
        model: 'sonnet',
        systemPrompt: 'sys',
        tools: ['Read'],
        jsonSchema: { type: 'object' },
        maxBudgetUsd: 1,
      };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--bare');
    });

    it('never produces --settings', () => {
      const req: InvocationRequest = {
        prompt: 'p',
        model: 'sonnet',
        systemPrompt: 'sys',
        tools: ['Read'],
        jsonSchema: { type: 'object' },
        maxBudgetUsd: 1,
      };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--settings');
    });

    it('never produces --mcp-config', () => {
      const req: InvocationRequest = { prompt: 'p' };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--mcp-config');
    });

    it('never produces --agents', () => {
      const req: InvocationRequest = { prompt: 'p' };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--agents');
    });

    it('never produces --add-dir', () => {
      const req: InvocationRequest = { prompt: 'p' };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--add-dir');
    });

    it('never produces --permission-mode', () => {
      const req: InvocationRequest = { prompt: 'p' };
      expect(buildCliArgs(req, emptyOpts)).not.toContain('--permission-mode');
    });
  });
});
