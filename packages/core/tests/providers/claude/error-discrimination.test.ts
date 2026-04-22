import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdkQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQuery(...args),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ): void => cb(null, 'claude 2.4.1\n', ''),
  };
});

import { ClaudeAgentSdkProvider } from '../../../src/providers/claude/provider.js';
import {
  ERROR_CODES,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '../../../src/errors.js';
import type {
  InvocationContext,
  InvocationRequest,
} from '../../../src/providers/types.js';
import type { Logger } from '../../../src/logger.js';

function makeLogger(): Logger {
  const noop = (): void => undefined;
  const stub: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    level: 'silent',
  };
  stub.child = function child(): Logger {
    return this as unknown as Logger;
  };
  return stub as unknown as Logger;
}

function makeCtx(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    flowName: 'f',
    runId: 'r',
    stepId: 'step-1',
    attempt: 2,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    ...overrides,
  };
}

function makeReq(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return { prompt: 'hello', model: 'sonnet', ...overrides };
}

/**
 * Returns an AsyncIterable whose first `next()` throws the supplied error.
 * Mirrors the SDK's behavior of surfacing transport errors through the
 * iterator rather than via the call to `query()` itself.
 */
function makeThrowingIterable(error: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw error;
        },
      };
    },
  };
}

describe('ClaudeAgentSdkProvider error discrimination', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('RELAY_ALLOW_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
    vi.stubEnv('ANTHROPIC_FOUNDRY_URL', '');
    sdkQuery.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sdkQuery.mockReset();
  });

  it('[ERR-DISC-001] rethrows AbortError so the runner abort path handles it', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    sdkQuery.mockReturnValue(makeThrowingIterable(abort));

    const p = new ClaudeAgentSdkProvider();
    await expect(p.invoke(makeReq(), makeCtx())).rejects.toBe(abort);
  });

  it('[ERR-DISC-002] rethrows DOMException-style aborts (code ABORT_ERR)', async () => {
    const abort = Object.assign(new Error('aborted via dom'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(abort));

    const p = new ClaudeAgentSdkProvider();
    await expect(p.invoke(makeReq(), makeCtx())).rejects.toBe(abort);
  });

  it('[ERR-DISC-003] wraps HTTP 429 into ProviderRateLimitError with original on details.cause', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(rateLimited));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(ProviderRateLimitError);
    expect(e.code).toBe(ERROR_CODES.PROVIDER_RATE_LIMIT);
    const rle = e as ProviderRateLimitError;
    expect(rle.providerName).toBe('claude');
    expect(rle.stepId).toBe('step-1');
    expect(rle.attempt).toBe(2);
    expect(rle.retryAfterMs).toBe(30_000);
    expect(rle.details?.['cause']).toBe(rateLimited);
  });

  it('[ERR-DISC-004] treats name RateLimitError without a status field as a rate limit', async () => {
    const typed = Object.assign(new Error('typed rate-limit'), {
      name: 'RateLimitError',
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(typed));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(ProviderRateLimitError);
  });

  it('[ERR-DISC-005] accepts a numeric retry-after header', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': 12 },
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(rateLimited));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isErr()).toBe(true);
    const rle = r._unsafeUnwrapErr() as ProviderRateLimitError;
    expect(rle.retryAfterMs).toBe(12_000);
  });

  it('[ERR-DISC-006] prefers retryAfter property over header when both present', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      retryAfter: 5,
      headers: { 'retry-after': '30' },
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(rateLimited));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    const rle = r._unsafeUnwrapErr() as ProviderRateLimitError;
    expect(rle.retryAfterMs).toBe(5_000);
  });

  it('[ERR-DISC-007] wraps ETIMEDOUT-style failures into TimeoutError', async () => {
    const timedOut = Object.assign(new Error('socket timeout'), {
      code: 'ETIMEDOUT',
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(timedOut));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(TimeoutError);
    expect(e.code).toBe(ERROR_CODES.TIMEOUT);
    expect(e.details?.['cause']).toBe(timedOut);
  });

  it('[ERR-DISC-008] wraps errors named TimeoutError into TimeoutError', async () => {
    const timedOut = Object.assign(new Error('server did not respond'), {
      name: 'TimeoutError',
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(timedOut));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(TimeoutError);
  });

  it('[ERR-DISC-009] falls through to StepFailureError with original on details.cause', async () => {
    const generic = new Error('boom');
    sdkQuery.mockReturnValue(makeThrowingIterable(generic));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(StepFailureError);
    expect(e.code).toBe(ERROR_CODES.STEP_FAILURE);
    const sfe = e as StepFailureError;
    expect(sfe.stepId).toBe('step-1');
    expect(sfe.attempt).toBe(2);
    expect(sfe.details?.['cause']).toBe(generic);
    expect(sfe.message).toBe('boom');
  });

  it('[ERR-DISC-010] non-Error thrown values still flow through StepFailureError', async () => {
    sdkQuery.mockReturnValue(makeThrowingIterable('string rejection'));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    const e = r._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(StepFailureError);
    expect(e.details?.['cause']).toBe('string rejection');
    expect(e.message).toBe('string rejection');
  });

  it('[ERR-DISC-011] status 429 routes to ProviderRateLimitError even without a name', async () => {
    const rateLimited = Object.assign(new Error('HTTP 429'), {
      statusCode: 429,
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(rateLimited));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r._unsafeUnwrapErr()).toBeInstanceOf(ProviderRateLimitError);
  });

  it('[ERR-DISC-012] does not wrap rate-limit errors as TimeoutError even if name collides', async () => {
    const rateLimited = Object.assign(new Error('limited'), {
      name: 'RateLimitError',
      status: 429,
    });
    sdkQuery.mockReturnValue(makeThrowingIterable(rateLimited));

    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    const e = r._unsafeUnwrapErr();
    expect(e).toBeInstanceOf(ProviderRateLimitError);
    expect(e).not.toBeInstanceOf(TimeoutError);
  });
});
