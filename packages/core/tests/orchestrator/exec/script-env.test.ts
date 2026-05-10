/**
 * Unit tests for resolveScriptEnv (packages/core/src/orchestrator/exec/script-env.ts)
 * and the scriptStepSpecSchema env field (packages/core/src/flow/schemas.ts).
 *
 * Coverage:
 *  - String literal → Handlebars template expansion
 *  - { from: 'input.<key>' } → value from ctx.input
 *  - { from: 'handoff.<key>.<nested>' } → nested dot-path resolution
 *  - { from: 'input.missing', required: true } → err(FlowDefinitionError)
 *  - { from: 'input.optional' } missing, not required → ok('')
 *  - Unrecognised from prefix → err(FlowDefinitionError)
 *  - undefined env map → ok({})
 *  - Multiple keys resolved together
 *  - Schema: env: { KEY: { from: 'input.repo' } } parses via scriptStepSpecSchema
 *  - Schema: env: { KEY: 'literal' } parses via scriptStepSpecSchema (backward compat)
 */

import { describe, expect, it } from 'vitest';
import { FlowDefinitionError } from '../../../src/errors.js';
import { scriptStepSpecSchema } from '../../../src/flow/schemas.js';
import type { ScriptEnvContext } from '../../../src/orchestrator/exec/script-env.js';
import { resolveScriptEnv } from '../../../src/orchestrator/exec/script-env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkCtx(overrides?: Partial<ScriptEnvContext>): ScriptEnvContext {
  return {
    input: {},
    handoffs: {},
    runDir: '/run',
    flowDir: '/flow',
    handoffsDir: '/run/handoffs',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveScriptEnv — unit tests
// ---------------------------------------------------------------------------

describe('resolveScriptEnv', () => {
  it('[ENV-001] string value is Handlebars-template-expanded against ctx', () => {
    const result = resolveScriptEnv(
      { REPO: '{{input.repo}}' },
      mkCtx({ input: { repo: 'my-repo' } }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ REPO: 'my-repo' });
  });

  it('[ENV-002] string literal with no template markers is passed through unchanged', () => {
    const result = resolveScriptEnv({ KEY: 'static-value' }, mkCtx());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ KEY: 'static-value' });
  });

  it('[ENV-003] { from: "input.<key>" } resolves from ctx.input', () => {
    const result = resolveScriptEnv(
      { REPO: { from: 'input.repo' } },
      mkCtx({ input: { repo: 'acme' } }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ REPO: 'acme' });
  });

  it('[ENV-004] { from: "handoff.<id>.<nested>" } resolves nested dot-path from ctx.handoffs', () => {
    const result = resolveScriptEnv(
      { TITLE: { from: 'handoff.pr_body.title' } },
      mkCtx({ handoffs: { pr_body: { title: 'Add feature X' } } }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ TITLE: 'Add feature X' });
  });

  it('[ENV-005] { from: "input.missing", required: true } returns err(FlowDefinitionError)', () => {
    const result = resolveScriptEnv(
      { KEY: { from: 'input.missing', required: true } },
      mkCtx({ input: { other: 'exists' } }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FlowDefinitionError);
    expect(result._unsafeUnwrapErr().message).toContain('input.missing');
  });

  it('[ENV-006] { from: "input.missing" } without required resolves to empty string', () => {
    const result = resolveScriptEnv({ KEY: { from: 'input.missing' } }, mkCtx({ input: {} }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ KEY: '' });
  });

  it('[ENV-007] unrecognised from prefix returns err(FlowDefinitionError) describing the issue', () => {
    const result = resolveScriptEnv({ KEY: { from: 'env.HOME' } }, mkCtx());
    expect(result.isErr()).toBe(true);
    const err = result._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect(err.message).toMatch(/unrecognized from prefix/);
    expect(err.message).toContain('env.HOME');
  });

  it('[ENV-008] undefined env map returns ok({})', () => {
    const result = resolveScriptEnv(undefined, mkCtx());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({});
  });

  it('[ENV-009] multiple keys are all resolved and returned together', () => {
    const result = resolveScriptEnv(
      {
        REPO: { from: 'input.repo' },
        BRANCH: 'main',
        PR_TITLE: { from: 'handoff.pr.title' },
      },
      mkCtx({
        input: { repo: 'relay' },
        handoffs: { pr: { title: 'Fix bug' } },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      REPO: 'relay',
      BRANCH: 'main',
      PR_TITLE: 'Fix bug',
    });
  });

  it('[ENV-010] first failing key short-circuits and returns err immediately', () => {
    const result = resolveScriptEnv(
      {
        BAD: { from: 'input.missing', required: true },
        GOOD: 'static',
      },
      mkCtx({ input: {} }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FlowDefinitionError);
  });

  it('[ENV-011] { from: "handoff.<id>", required: true } with missing handoff returns err', () => {
    const result = resolveScriptEnv(
      { BODY: { from: 'handoff.pr_body', required: true } },
      mkCtx({ handoffs: {} }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FlowDefinitionError);
    expect(result._unsafeUnwrapErr().message).toContain('handoff.pr_body');
  });
});

// ---------------------------------------------------------------------------
// scriptStepSpecSchema — env field schema tests (items 8 & 9 from task spec)
// ---------------------------------------------------------------------------

describe('scriptStepSpecSchema — env field', () => {
  const baseSpec = {
    id: 'build',
    kind: 'script' as const,
    run: 'node build.js',
  };

  it('[SCHEMA-ENV-001] env: { KEY: { from: "input.repo" } } parses cleanly', () => {
    const result = scriptStepSpecSchema.safeParse({
      ...baseSpec,
      env: { REPO: { from: 'input.repo' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({ REPO: { from: 'input.repo' } });
    }
  });

  it('[SCHEMA-ENV-002] env: { KEY: "literal" } parses cleanly (backward compatibility)', () => {
    const result = scriptStepSpecSchema.safeParse({
      ...baseSpec,
      env: { TOKEN: 'literal-value' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({ TOKEN: 'literal-value' });
    }
  });

  it('[SCHEMA-ENV-003] env: mixed literal and from-spec in the same map parses cleanly', () => {
    const result = scriptStepSpecSchema.safeParse({
      ...baseSpec,
      env: {
        REPO: { from: 'input.repo' },
        BRANCH: 'main',
      },
    });
    expect(result.success).toBe(true);
  });

  it('[SCHEMA-ENV-004] env: { KEY: { from: "input.repo", required: true } } parses cleanly', () => {
    const result = scriptStepSpecSchema.safeParse({
      ...baseSpec,
      env: { REPO: { from: 'input.repo', required: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env?.REPO).toMatchObject({ from: 'input.repo', required: true });
    }
  });

  it('[SCHEMA-ENV-005] env absent is allowed (field is optional)', () => {
    const result = scriptStepSpecSchema.safeParse(baseSpec);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toBeUndefined();
    }
  });

  it('[SCHEMA-ENV-006] env: { KEY: { from: "" } } fails (from must be non-empty)', () => {
    const result = scriptStepSpecSchema.safeParse({
      ...baseSpec,
      env: { REPO: { from: '' } },
    });
    expect(result.success).toBe(false);
  });
});
