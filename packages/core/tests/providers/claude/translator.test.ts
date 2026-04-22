/**
 * End-to-end checks that the provider resolves tool_use_id to tool name
 * across translated events, and that the SDK's result.stop_reason reaches
 * InvocationResponse.stopReason unchanged.
 *
 * The translator alone is pure and emits name: 'unknown' for tool.result
 * because resolution requires cross-message state. The provider owns a
 * per-stream Map<tool_use_id, tool_name> populated on tool.call and consulted
 * on tool.result. These tests drive the full provider path so the map's
 * behavior is observable.
 */

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
import type {
  InvocationContext,
  InvocationEvent,
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

describe('ClaudeAgentSdkProvider translator integration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('RELAY_ALLOW_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
    sdkQuery.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sdkQuery.mockReset();
  });

  it('[TRANSLATOR-001] two tool_use/tool_result pairs resolve their names through the id->name map', async () => {
    // Two distinct tool calls, each followed by its matching result. A third
    // tool_result with an unknown id also appears to verify that ids the
    // map never saw stay as 'unknown' rather than grabbing a wrong neighbor.
    const messages: unknown[] = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: 'ok' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_02', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_02', is_error: true },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_missing', is_error: false },
          ],
        },
      },
    ];

    sdkQuery.mockReturnValue(makeAsyncIterable(messages));
    const provider = new ClaudeAgentSdkProvider();

    const events: InvocationEvent[] = [];
    if (provider.stream === undefined) {
      throw new Error('provider.stream is required for this test');
    }
    for await (const event of provider.stream(makeReq(), makeCtx())) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === 'tool.call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ type: 'tool.call', name: 'Read', toolUseId: 'toolu_01' });
    expect(toolCalls[1]).toMatchObject({ type: 'tool.call', name: 'Grep', toolUseId: 'toolu_02' });

    const toolResults = events.filter((e) => e.type === 'tool.result');
    expect(toolResults).toHaveLength(3);

    // First pair: id was seen on tool.call, so name resolves to 'Read'.
    expect(toolResults[0]).toMatchObject({
      type: 'tool.result',
      name: 'Read',
      ok: true,
      toolUseId: 'toolu_01',
    });

    // Second pair: id was seen on tool.call, so name resolves to 'Grep'.
    // is_error: true flips ok to false.
    expect(toolResults[1]).toMatchObject({
      type: 'tool.result',
      name: 'Grep',
      ok: false,
      toolUseId: 'toolu_02',
    });

    // Unknown id: no prior tool.call seen, so the fallback 'unknown' stands.
    expect(toolResults[2]).toMatchObject({
      type: 'tool.result',
      name: 'unknown',
      ok: true,
      toolUseId: 'toolu_missing',
    });
  });

  it('[TRANSLATOR-002] result.stop_reason = max_tokens reaches InvocationResponse.stopReason', async () => {
    const messages: unknown[] = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial output' } },
      {
        type: 'result',
        usage: { input_tokens: 200, output_tokens: 80 },
        stop_reason: 'max_tokens',
        session_id: 'sess-max',
        num_turns: 2,
        model: 'claude-sonnet-4-6',
      },
    ];

    sdkQuery.mockReturnValue(makeAsyncIterable(messages));
    const provider = new ClaudeAgentSdkProvider();
    const result = await provider.invoke(makeReq(), makeCtx());

    expect(result.isOk()).toBe(true);
    const response = result._unsafeUnwrap();
    expect(response.stopReason).toBe('max_tokens');
    expect(response.sessionId).toBe('sess-max');
    expect(response.numTurns).toBe(2);
    expect(response.model).toBe('claude-sonnet-4-6');
  });

  it('[TRANSLATOR-003] each documented stop_reason value passes through unchanged', async () => {
    const stopReasons = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'] as const;

    for (const stopReason of stopReasons) {
      sdkQuery.mockReset();
      sdkQuery.mockReturnValue(
        makeAsyncIterable<unknown>([
          {
            type: 'result',
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: stopReason,
            num_turns: 1,
            model: 'claude-sonnet-4-6',
          },
        ]),
      );

      const provider = new ClaudeAgentSdkProvider();
      const result = await provider.invoke(makeReq(), makeCtx());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().stopReason).toBe(stopReason);
    }
  });
});
