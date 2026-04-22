import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SDK mock: hoisted to module top. query() returns an async iterable we control per test.
const sdkQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQuery(...args),
}));

// Mock node:child_process so authenticate()'s claude --version probe never spawns.
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
    stepId: 's',
    attempt: 1,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    ...overrides,
  };
}

function makeReq(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return { prompt: 'hello', model: 'sonnet', ...overrides };
}

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) return { value: items[i++]!, done: false };
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

function successMessages() {
  return [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
    {
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
      session_id: 's1',
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    },
  ];
}

describe('ClaudeAgentSdkProvider', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Clear every env var that could steer authenticate().
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

  it('[CLAUDE-001] authenticate() accepts ANTHROPIC_API_KEY and returns api-account billing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');

    const p = new ClaudeAgentSdkProvider();
    const r = await p.authenticate();

    expect(r.isOk()).toBe(true);
    const state = r._unsafeUnwrap();
    expect(state.billingSource).toBe('api-account');
    expect(state.detail).toContain('ANTHROPIC_API_KEY');
  });

  it('[CLAUDE-002] invoke aggregates stream events into a single InvocationResponse', async () => {
    sdkQuery.mockReturnValue(makeAsyncIterable(successMessages()));
    const p = new ClaudeAgentSdkProvider();
    const r = await p.invoke(makeReq(), makeCtx());
    expect(r.isOk()).toBe(true);
    const resp = r._unsafeUnwrap();
    expect(resp.text).toBe('Hello world');
    expect(resp.usage.inputTokens).toBe(100);
    expect(resp.usage.outputTokens).toBe(50);
    expect(resp.stopReason).toBe('end_turn');
    expect(resp.sessionId).toBe('s1');
    expect(resp.model).toBe('claude-sonnet-4-6');
  });

  it('[CLAUDE-003] options.env contains PATH at real value and SLACK_TOKEN as undefined patch', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('SLACK_TOKEN', 'xoxb-secret');

    let capturedOptions: Record<string, unknown> | undefined;
    sdkQuery.mockImplementation((params: { prompt: string; options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return makeAsyncIterable(successMessages());
    });

    const p = new ClaudeAgentSdkProvider();
    await p.invoke(makeReq(), makeCtx());

    expect(capturedOptions).toBeDefined();
    const env = capturedOptions?.env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect('SLACK_TOKEN' in env).toBe(true);
    expect(env.SLACK_TOKEN).toBeUndefined();
  });

  it('[CLAUDE-004] aborting ctx.abortSignal aborts the controller passed to query()', async () => {
    const outerController = new AbortController();
    let capturedController: AbortController | undefined;
    sdkQuery.mockImplementation((params: { prompt: string; options?: Record<string, unknown> }) => {
      capturedController = params.options?.abortController as AbortController;
      outerController.abort();
      return makeAsyncIterable(successMessages());
    });

    const p = new ClaudeAgentSdkProvider();
    await p.invoke(makeReq(), makeCtx({ abortSignal: outerController.signal }));

    expect(capturedController).toBeDefined();
    expect(capturedController?.signal.aborted).toBe(true);
  });

  it('[CLAUDE-005] capabilities advertise the documented built-in tools + model aliases', () => {
    const p = new ClaudeAgentSdkProvider();
    const caps = p.capabilities;
    expect(caps.streaming).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.multimodal).toBe(true);
    expect(caps.budgetCap).toBe(true);

    for (const t of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']) {
      expect(caps.builtInTools).toContain(t);
    }
    for (const m of ['sonnet', 'haiku', 'opus']) {
      expect(caps.models).toContain(m);
    }
    expect(caps.maxContextTokens).toBeGreaterThanOrEqual(100_000);
  });

  it('[CLAUDE-006] abortController and env are always set by provider on every invocation', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    sdkQuery.mockImplementation((params: { prompt: string; options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return makeAsyncIterable(successMessages());
    });

    const p = new ClaudeAgentSdkProvider();
    await p.invoke(makeReq(), makeCtx());

    // Safety-critical fields are always set by the provider.
    expect(capturedOptions?.abortController).toBeDefined();
    expect(capturedOptions?.env).toBeDefined();
  });
});
