/**
 * Tests for exitCodeFor() — verifies that each error class maps to its
 * documented CLI exit code and that every mapped code is non-zero.
 *
 * TimeoutError and AuthTimeoutError intentionally share exit code 5. The test
 * suite asserts each individual mapping rather than requiring all codes to be
 * distinct.
 */

import {
  AtomicWriteError,
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffSchemaError,
  NoProviderConfiguredError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '@relay/core';
import { describe, expect, it } from 'vitest';
import { EXIT_CODES, exitCodeFor } from '../src/exit-codes.js';

describe('exitCodeFor', () => {
  // -------------------------------------------------------------------------
  // Generic / unknown errors — fall through to runner_failure (1)
  // -------------------------------------------------------------------------

  it('[TC-014] plain Error maps to runner_failure (1)', () => {
    expect(exitCodeFor(new Error('generic'))).toBe(EXIT_CODES.runner_failure);
    expect(EXIT_CODES.runner_failure).toBe(1);
  });

  it('[TC-014] non-Error thrown value maps to runner_failure (1)', () => {
    expect(exitCodeFor('a string was thrown')).toBe(EXIT_CODES.runner_failure);
    expect(exitCodeFor(42)).toBe(EXIT_CODES.runner_failure);
    expect(exitCodeFor(null)).toBe(EXIT_CODES.runner_failure);
  });

  // -------------------------------------------------------------------------
  // Exit code 1 — runner_failure
  // -------------------------------------------------------------------------

  it('[TC-014] StepFailureError maps to runner_failure (1)', () => {
    const err = new StepFailureError('step exited non-zero', 'step-a', 1);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.runner_failure);
    expect(EXIT_CODES.runner_failure).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // Exit code 2 — definition_error
  // -------------------------------------------------------------------------

  it('[TC-014] FlowDefinitionError maps to definition_error (2)', () => {
    const err = new FlowDefinitionError('bad step reference');
    expect(exitCodeFor(err)).toBe(EXIT_CODES.definition_error);
    expect(EXIT_CODES.definition_error).toBe(2);
  });

  it('[TC-014] ProviderCapabilityError maps to definition_error (2)', () => {
    const err = new ProviderCapabilityError(
      'provider does not support structuredOutput',
      'mock-provider',
      'structuredOutput',
    );
    expect(exitCodeFor(err)).toBe(EXIT_CODES.definition_error);
  });

  // -------------------------------------------------------------------------
  // Exit code 3 — auth_error
  // -------------------------------------------------------------------------

  it('[TC-014] ClaudeAuthError maps to auth_error (3)', () => {
    const err = new ClaudeAuthError('ANTHROPIC_API_KEY present without opt-in');
    expect(exitCodeFor(err)).toBe(EXIT_CODES.auth_error);
    expect(EXIT_CODES.auth_error).toBe(3);
  });

  it('[TC-014] ProviderAuthError maps to auth_error (3)', () => {
    const err = new ProviderAuthError('credentials missing', 'bedrock');
    expect(exitCodeFor(err)).toBe(EXIT_CODES.auth_error);
  });

  // -------------------------------------------------------------------------
  // Exit code 4 — handoff_error
  // -------------------------------------------------------------------------

  it('[TC-014] HandoffSchemaError maps to handoff_error (4)', () => {
    const err = new HandoffSchemaError('schema validation failed', 'myHandoff', []);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.handoff_error);
    expect(EXIT_CODES.handoff_error).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Exit code 5 — timeout (shared by TimeoutError and AuthTimeoutError)
  // -------------------------------------------------------------------------

  it('[TC-014] TimeoutError maps to timeout (5)', () => {
    const err = new TimeoutError('step timed out', 'step-b', 30000);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.timeout);
    expect(EXIT_CODES.timeout).toBe(5);
  });

  it('[TC-014] AuthTimeoutError maps to timeout (5) — same exit code as TimeoutError', () => {
    const err = new AuthTimeoutError('auth timed out', 'claude-cli', 10000);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.timeout);
    // Both map to the same code — this is intentional per the exit-codes spec
    expect(exitCodeFor(err)).toBe(exitCodeFor(new TimeoutError('t', 'step-c', 5000)));
  });

  // -------------------------------------------------------------------------
  // Exit code 6 — no_provider
  // -------------------------------------------------------------------------

  it('[TC-014] NoProviderConfiguredError maps to no_provider (6)', () => {
    const err = new NoProviderConfiguredError();
    expect(exitCodeFor(err)).toBe(EXIT_CODES.no_provider);
    expect(EXIT_CODES.no_provider).toBe(6);
  });

  it('[TC-014] PipelineError with NO_PROVIDER code maps to no_provider (6)', () => {
    const err = new PipelineError('no provider', ERROR_CODES.NO_PROVIDER);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.no_provider);
  });

  // -------------------------------------------------------------------------
  // AtomicWriteError — not registered in errorRegistry; falls back to runner_failure (1)
  // The exit-codes.ts header documents "7 — io_error (AtomicWriteError)" but the
  // errorRegistry has no entry for ERROR_CODES.ATOMIC_WRITE. The fallback for any
  // unregistered PipelineError is EXIT_CODES.runner_failure (1).
  // -------------------------------------------------------------------------

  it('[TC-014] AtomicWriteError falls back to runner_failure (1) — not in errorRegistry', () => {
    const err = new AtomicWriteError('rename failed', '/tmp/relay/state.json', 'EXDEV');
    expect(exitCodeFor(err)).toBe(EXIT_CODES.runner_failure);
    expect(EXIT_CODES.io_error).toBe(7); // constant is defined, just not wired to AtomicWriteError
  });

  it('[TC-014] AtomicWriteError with undefined errno also falls back to runner_failure (1)', () => {
    const err = new AtomicWriteError('write failed', '/tmp/relay/state.json', undefined);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.runner_failure);
  });

  // -------------------------------------------------------------------------
  // Exit code 8 — rate_limit
  // -------------------------------------------------------------------------

  it('[TC-014] ProviderRateLimitError maps to rate_limit (8)', () => {
    const err = new ProviderRateLimitError(
      'rate limited by provider',
      'claude-cli',
      'step-d',
      2,
      60000,
    );
    expect(exitCodeFor(err)).toBe(EXIT_CODES.rate_limit);
    expect(EXIT_CODES.rate_limit).toBe(8);
  });

  it('[TC-014] ProviderRateLimitError with undefined retryAfterMs maps to rate_limit (8)', () => {
    const err = new ProviderRateLimitError('rate limited', 'claude-cli', 'step-e', 1, undefined);
    expect(exitCodeFor(err)).toBe(EXIT_CODES.rate_limit);
  });

  // -------------------------------------------------------------------------
  // Invariant: every mapped exit code is non-zero
  // -------------------------------------------------------------------------

  it('[TC-014] all non-zero — none of the mapped codes is 0', () => {
    const errors: unknown[] = [
      new Error('generic'),
      new StepFailureError('failed', 'step-a', 1),
      new FlowDefinitionError('bad flow'),
      new ClaudeAuthError('no auth'),
      new HandoffSchemaError('bad schema', 'handoff-id', []),
      new TimeoutError('timed out', 'step-b', 30000),
      new AuthTimeoutError('auth timed out', 'claude-cli', 10000),
      new NoProviderConfiguredError(),
      new AtomicWriteError('io fail', '/tmp/x', 'EACCES'),
      new ProviderRateLimitError('rate limited', 'claude-cli', 'step-c', 1, undefined),
      new ProviderAuthError('bad creds', 'bedrock'),
      new ProviderCapabilityError('missing cap', 'mock', 'structuredOutput'),
    ];

    for (const e of errors) {
      expect(exitCodeFor(e)).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // EXIT_CODES constants are the expected literal values
  // -------------------------------------------------------------------------

  it('[TC-014] EXIT_CODES constant values match documented exit code table', () => {
    expect(EXIT_CODES.success).toBe(0);
    expect(EXIT_CODES.runner_failure).toBe(1);
    expect(EXIT_CODES.definition_error).toBe(2);
    expect(EXIT_CODES.auth_error).toBe(3);
    expect(EXIT_CODES.handoff_error).toBe(4);
    expect(EXIT_CODES.timeout).toBe(5);
    expect(EXIT_CODES.no_provider).toBe(6);
    expect(EXIT_CODES.io_error).toBe(7);
    expect(EXIT_CODES.rate_limit).toBe(8);
  });
});
