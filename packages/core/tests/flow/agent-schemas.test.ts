import { describe, expect, it } from 'vitest';
import {
  agentDefinitionSchema,
  agentsFromSpecSchema,
  promptStepSpecSchema,
} from '../../src/flow/schemas.js';

// ---------------------------------------------------------------------------
// agentDefinitionSchema
// ---------------------------------------------------------------------------

describe('agentDefinitionSchema', () => {
  it('accepts a definition with systemPrompt only (no extends)', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'summarizer',
      systemPrompt: 'You summarize.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a definition with extends only (no systemPrompt)', () => {
    const result = agentDefinitionSchema.safeParse({ name: 'derived', extends: 'base-agent' });
    expect(result.success).toBe(true);
  });

  it('accepts a definition with both extends and systemPrompt', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'both',
      extends: 'base-agent',
      systemPrompt: 'Override prompt.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a definition with neither extends nor systemPrompt', () => {
    const result = agentDefinitionSchema.safeParse({ name: 'empty-agent' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('extends') || m.includes('systemPrompt'))).toBe(true);
    }
  });

  it('accepts optional fields: description, model, tools, skills, skillsMerge', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'full-agent',
      systemPrompt: 'You do everything.',
      description: 'A capable agent',
      model: 'claude-opus-4-5',
      tools: ['read_file', 'write_file'],
      skills: ['code-review'],
      skillsMerge: 'append',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (strictObject)', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'strict-test',
      systemPrompt: 'Hello.',
      unknownProp: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('rejects skillsMerge with invalid value', () => {
    const result = agentDefinitionSchema.safeParse({
      name: 'bad-merge',
      systemPrompt: 'Hello.',
      skillsMerge: 'merge-all',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agentsFromSpecSchema
// ---------------------------------------------------------------------------

describe('agentsFromSpecSchema', () => {
  it('accepts { from: "handoff.plan" }', () => {
    const result = agentsFromSpecSchema.safeParse({ from: 'handoff.plan' });
    expect(result.success).toBe(true);
  });

  it('accepts { from: "handoff.plan", path: "$.agents", required: true }', () => {
    const result = agentsFromSpecSchema.safeParse({
      from: 'handoff.plan',
      path: '$.agents',
      required: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty from string', () => {
    const result = agentsFromSpecSchema.safeParse({ from: '' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = agentsFromSpecSchema.safeParse({ from: 'handoff.plan', extra: 'bad' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// promptStepSpecSchema — agents field
// ---------------------------------------------------------------------------

describe('promptStepSpecSchema — agents field', () => {
  const baseStep = {
    id: 'my-step',
    kind: 'prompt' as const,
    promptFile: 'prompt.md',
    output: { handoff: 'result' },
  };

  it('accepts a step with inline agents array (valid, unique names)', () => {
    const result = promptStepSpecSchema.safeParse({
      ...baseStep,
      agents: [
        { name: 'alpha', systemPrompt: 'You are alpha.' },
        { name: 'beta', extends: 'alpha' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a step with agents: { from: "handoff.agents" }', () => {
    const result = promptStepSpecSchema.safeParse({
      ...baseStep,
      agents: { from: 'handoff.agents' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an agents array with duplicate names', () => {
    const result = promptStepSpecSchema.safeParse({
      ...baseStep,
      agents: [
        { name: 'dup', systemPrompt: 'First.' },
        { name: 'dup', systemPrompt: 'Second.' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('unique'))).toBe(true);
    }
  });

  it('accepts a step with no agents field (backward compatibility)', () => {
    const result = promptStepSpecSchema.safeParse(baseStep);
    expect(result.success).toBe(true);
  });
});
