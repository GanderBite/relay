import { describe, it, expect } from 'vitest';

import { classifyExit } from '../../../src/providers/claude-cli/classify-exit.js';
import {
  ProviderRateLimitError,
  ProviderAuthError,
  StepFailureError,
} from '../../../src/errors.js';
import { GITHUB_ISSUES_URL } from '../../../src/constants.js';

const BASE = {
  stepId: 'step-1',
  attempt: 1,
  providerName: 'claude-cli',
};

describe('classifyExit', () => {
  it('returns null when exitCode is 0 and aborted is false', () => {
    expect(classifyExit({ ...BASE, exitCode: 0, stderr: '', aborted: false })).toBeNull();
  });

  it('returns null when aborted is true regardless of non-zero exit code', () => {
    expect(classifyExit({ ...BASE, exitCode: 1, stderr: 'some error', aborted: true })).toBeNull();
  });

  it('returns null when aborted is true and exitCode is null', () => {
    expect(classifyExit({ ...BASE, exitCode: null, stderr: '', aborted: true })).toBeNull();
  });

  it('returns ProviderRateLimitError on "rate limit" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'rate limit exceeded',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    const rle = err as ProviderRateLimitError;
    expect(rle.stepId).toBe(BASE.stepId);
    expect(rle.attempt).toBe(BASE.attempt);
    expect(rle.providerName).toBe(BASE.providerName);
  });

  it('returns ProviderRateLimitError on "HTTP 429" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'HTTP 429 Too Many Requests',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
  });

  it('returns ProviderRateLimitError on "status 429" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'received status 429 from server',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
  });

  it('returns ProviderRateLimitError on "rate-limit" (hyphen variant) in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'rate-limit hit',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
  });

  it('returns StepFailureError with E_CLAUDE_CLI_TIMEOUT on "timeout" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'operation timeout after 30s',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    const sfe = err as StepFailureError;
    expect(sfe.stepId).toBe(BASE.stepId);
    expect(sfe.details?.errorCode).toBe('E_CLAUDE_CLI_TIMEOUT');
  });

  it('returns StepFailureError with E_CLAUDE_CLI_TIMEOUT on "ETIMEDOUT" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'connect ETIMEDOUT 10.0.0.1:443',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    expect((err as StepFailureError).details?.errorCode).toBe('E_CLAUDE_CLI_TIMEOUT');
  });

  it('returns StepFailureError with E_CLAUDE_CLI_TIMEOUT on "deadline exceeded" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'context deadline exceeded',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    expect((err as StepFailureError).details?.errorCode).toBe('E_CLAUDE_CLI_TIMEOUT');
  });

  it('returns ProviderAuthError on "authentication" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'authentication failed',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderAuthError);
    const ae = err as ProviderAuthError;
    expect(ae.providerName).toBe(BASE.providerName);
  });

  it('returns ProviderAuthError on "HTTP 401" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'HTTP 401 Unauthorized',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderAuthError);
  });

  it('returns ProviderAuthError on "invalid api key" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'invalid api key provided',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderAuthError);
  });

  it('returns ProviderAuthError on "session expired" in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'session expired, please log in again',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderAuthError);
  });

  it('returns StepFailureError with E_CLAUDE_CLI_FAIL details for unknown non-zero exit', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'something unexpected happened',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    const sfe = err as StepFailureError;
    expect(sfe.message).toContain('claude -p exit 1');
    expect(sfe.message).toContain('something unexpected happened');
    expect(sfe.details?.errorCode).toBe('E_CLAUDE_CLI_FAIL');
    expect(sfe.details?.reportUrl).toBe(GITHUB_ISSUES_URL);
    expect(sfe.stepId).toBe(BASE.stepId);
    expect(sfe.attempt).toBe(BASE.attempt);
  });

  it('returns StepFailureError when exitCode is null (killed without code)', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: null,
      stderr: 'process was killed',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    const sfe = err as StepFailureError;
    expect(sfe.message).toContain('claude -p exit null');
    expect(sfe.details?.errorCode).toBe('E_CLAUDE_CLI_FAIL');
  });

  it('truncates stderr to 400 chars in the StepFailureError message', () => {
    const longStderr = 'x'.repeat(500);
    const err = classifyExit({
      ...BASE,
      exitCode: 2,
      stderr: longStderr,
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    const sfe = err as StepFailureError;
    const stderrPart = sfe.message.replace('claude -p exit 2: ', '');
    expect(stderrPart).toHaveLength(400);
  });

  it('rate-limit match takes priority over timeout when both appear in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'rate limit timeout ETIMEDOUT',
      aborted: false,
    });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
  });

  it('timeout match takes priority over auth when both appear in stderr', () => {
    const err = classifyExit({
      ...BASE,
      exitCode: 1,
      stderr: 'timeout authentication failed',
      aborted: false,
    });
    expect(err).toBeInstanceOf(StepFailureError);
    expect((err as StepFailureError).details?.errorCode).toBe('E_CLAUDE_CLI_TIMEOUT');
  });
});
