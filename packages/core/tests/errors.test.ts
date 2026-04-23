import { describe, expect, it } from 'vitest';

import {
  AtomicWriteError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffIoError,
  HandoffNotFoundError,
  HandoffSchemaError,
  HandoffWriteError,
  MetricsWriteError,
  type PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  StateCorruptError,
  StateNotFoundError,
  StateTransitionError,
  StateVersionMismatchError,
  StateWriteError,
  StepFailureError,
  TimeoutError,
} from '../src/errors.js';
import { parseWithSchema, safeParse, safeStringify } from '../src/util/json.js';
import { lookup, ValueNotFoundError } from '../src/util/map-utils.js';
import { z } from '../src/zod.js';

describe('Error hierarchy', () => {
  it('[ERROR-001] every concrete error class has a stable code from ERROR_CODES', () => {
    const instances: PipelineError[] = [
      new FlowDefinitionError('msg'),
      new StepFailureError('msg', 'step-1', 1),
      new ClaudeAuthError('msg'),
      new HandoffSchemaError('msg', 'h', []),
      new HandoffIoError('msg', 'h'),
      new HandoffNotFoundError('msg', 'h'),
      new HandoffWriteError('msg', 'h'),
      new MetricsWriteError('msg'),
      new StateCorruptError('msg'),
      new StateNotFoundError('msg', '/dir'),
      new StateTransitionError('msg', 'step-1'),
      new StateVersionMismatchError(
        'msg',
        { flowName: 'a', flowVersion: '1' },
        { flowName: 'b', flowVersion: '2' },
      ),
      new StateWriteError('msg'),
      new TimeoutError('msg', 'step-1', 5000),
      new ProviderAuthError('msg', 'mock'),
      new ProviderCapabilityError('msg', 'mock', 'structuredOutput'),
      new AtomicWriteError('msg', '/tmp/x', 'ENOSPC'),
    ];

    const allCodes = Object.values(ERROR_CODES);
    const seen = new Set<string>();
    for (const inst of instances) {
      expect(typeof inst.code).toBe('string');
      expect(allCodes).toContain(inst.code);
      expect(seen.has(inst.code)).toBe(false);
      seen.add(inst.code);
    }
    // All 17 distinct classes should occupy all 17 codes.
    expect(seen.size).toBe(instances.length);
  });

  it('[ERROR-002] StepFailureError preserves stepId + attempt as own properties', () => {
    const e = new StepFailureError('nope', 'inventory', 3);
    expect(e.stepId).toBe('inventory');
    expect(e.attempt).toBe(3);
    expect(e.code).toBe(ERROR_CODES.STEP_FAILURE);
  });
});

describe('util/json', () => {
  it('[ERROR-003] parseWithSchema on invalid JSON returns err with cause', () => {
    const r = parseWithSchema('not json {', z.object({ x: z.string() }));
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect(typeof err.details?.cause).toBe('string');
    expect((err.details?.cause as string).length).toBeGreaterThan(0);
  });

  it('[ERROR-004] safeStringify escapes < and > to prevent tag-injection', () => {
    const out = safeStringify({ body: '<script>alert(1)</script>' });
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    // The escapeString helper injects the literal 6-char sequence \u003c /
    // \u003e into each string value before JSON.stringify, which then escapes
    // the backslash — so the on-the-wire output is \\u003c / \\u003e.
    expect(out).toContain('\\\\u003cscript\\\\u003e');
    expect(out).toContain('\\\\u003c/script\\\\u003e');
  });

  it('safeParse returns ok on valid JSON', () => {
    const r = safeParse('{"x":1}');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual({ x: 1 });
  });

  it('safeParse returns err(FlowDefinitionError) on invalid JSON', () => {
    const r = safeParse('not json');
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(FlowDefinitionError);
    expect(r._unsafeUnwrapErr().code).toBe(ERROR_CODES.FLOW_DEFINITION);
  });
});

describe('util/map-utils.lookup', () => {
  it('[ERROR-005] lookup on a missing key returns err, does not throw', () => {
    const m = new Map<string, number>([['a', 1]]);
    expect(() => lookup(m, 'b')).not.toThrow();
    const r = lookup(m, 'b');
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err).toBeInstanceOf(ValueNotFoundError);
    expect(err.key).toBe('b');
  });

  it('lookup on a hit returns ok with the value', () => {
    const r = lookup(new Map([['a', 1]]), 'a');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(1);
  });
});
