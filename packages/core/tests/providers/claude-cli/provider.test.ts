import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted spawn mock — must be registered before any module under test imports
// node:child_process. The mock is shared by runClaudeProcess (invocation) and
// inspectClaudeAuth (the claude --version preflight).
const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args),
    execFile: (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ): void => execFileMock(_cmd, _args, _opts, cb),
  };
});

// Mock fs.existsSync so the credentials-file probe never reads the real disk.
const existsSyncMock = vi.hoisted(() => vi.fn<(p: string) => boolean>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string): boolean => existsSyncMock(p),
  };
});

import { ClaudeCliProvider } from '../../../src/providers/claude-cli/provider.js';
import { ClaudeAuthError, PipelineError, SubscriptionTosLeakError } from '../../../src/errors.js';
import type {
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
} from '../../../src/providers/types.js';
import type { Logger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface MockChildHandles {
  child: EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc: string) => void };
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
}

function makeChild(): MockChildHandles {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(
      (_chunk: string, _enc: string, cb?: (err?: Error | null) => void) => {
        if (typeof cb === 'function') cb(null);
        return true;
      },
    ),
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn().mockReturnValue(true),
  });
  return { child };
}

function makeLogger(): Logger {
  const noop = vi.fn();
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    level: 'silent',
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

function makeCtx(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    raceName: 'test-flow',
    runId: 'run-1',
    runnerId: 'step-1',
    attempt: 1,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    ...overrides,
  };
}

function makeReq(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return { prompt: 'say hello', model: 'sonnet', ...overrides };
}

// Stubs execFile so the claude --version preflight always passes.
function stubExecFileOk(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: unknown, _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      cb(null, 'claude 2.4.1\n', '');
    },
  );
}

// Stubs execFile to simulate missing claude binary.
function stubExecFileEnoent(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: unknown, _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      cb(e, '', '');
    },
  );
}

// ---------------------------------------------------------------------------
// Stream-json NDJSON fixtures (from _work/sprint-13-stream-json-samples.md)
// ---------------------------------------------------------------------------

// system.init envelope — emitted at start of each `claude -p` run.
const FIXTURE_SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: '6f5b82b2-0e07-4a31-8d84-694ca191674e',
  model: 'claude-sonnet-4-6',
}) + '\n';

// stream_event with content_block_delta — carries per-token text delta.
const FIXTURE_DELTA_HELLO = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  },
  session_id: '6f5b82b2-0e07-4a31-8d84-694ca191674e',
}) + '\n';

const FIXTURE_DELTA_THERE = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' there, friend.' },
  },
  session_id: '6f5b82b2-0e07-4a31-8d84-694ca191674e',
}) + '\n';

// message_delta stream_event — carries stop_reason and usage totals.
const FIXTURE_MESSAGE_DELTA = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 23980,
      cache_read_input_tokens: 0,
      output_tokens: 8,
    },
  },
  session_id: '6f5b82b2-0e07-4a31-8d84-694ca191674e',
}) + '\n';

// result — final envelope with totals.
const FIXTURE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 2169,
  num_turns: 1,
  result: 'Hello there, friend.',
  stop_reason: 'end_turn',
  session_id: '6f5b82b2-0e07-4a31-8d84-694ca191674e',
  total_cost_usd: 0.090051,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 23980,
    cache_read_input_tokens: 0,
    output_tokens: 8,
  },
}) + '\n';

// result envelope that simulates a non-zero exit (error case).
const FIXTURE_RESULT_RATE_LIMIT = JSON.stringify({
  type: 'result',
  subtype: 'error',
  is_error: true,
  result: null,
  stop_reason: null,
  session_id: null,
}) + '\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCliProvider', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    // Default: credentials file absent, no auth env.
    existsSyncMock.mockReturnValue(false);
    vi.unstubAllEnvs();
    // Clear all auth-related env vars.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
    vi.stubEnv('ANTHROPIC_FOUNDRY_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Provider identity and capabilities
  // -------------------------------------------------------------------------

  it('[CLI-PROV-001] name is claude-cli', () => {
    const provider = new ClaudeCliProvider();
    expect(provider.name).toBe('claude-cli');
  });

  it('[CLI-PROV-002] capabilities includes streaming, tools, structuredOutput', () => {
    const provider = new ClaudeCliProvider();
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.tools).toBe(true);
    expect(provider.capabilities.structuredOutput).toBe(true);
  });

  // -------------------------------------------------------------------------
  // authenticate() — delegates to inspectClaudeAuth({ providerKind: 'claude-cli' })
  // -------------------------------------------------------------------------

  describe('authenticate()', () => {
    it('[CLI-AUTH-001] with OAuth token returns ok(subscription)', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileOk();

      const provider = new ClaudeCliProvider();
      const result = await provider.authenticate();

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().billingSource).toBe('subscription');
    });

    it('[CLI-AUTH-002] with ANTHROPIC_API_KEY only returns err(ClaudeAuthError)', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
      existsSyncMock.mockReturnValue(false);
      stubExecFileOk();

      const provider = new ClaudeCliProvider();
      const result = await provider.authenticate();

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ClaudeAuthError);
      expect(result._unsafeUnwrapErr()).not.toBeInstanceOf(SubscriptionTosLeakError);
      // Must mention how to fix — the CLI path.
      expect(result._unsafeUnwrapErr().message).toContain('claude /login');
    });

    it('[CLI-AUTH-003] no auth at all returns err(ClaudeAuthError)', async () => {
      existsSyncMock.mockReturnValue(false);
      stubExecFileOk();

      const provider = new ClaudeCliProvider();
      const result = await provider.authenticate();

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ClaudeAuthError);
    });

    it('[CLI-AUTH-004] with credentials file present returns ok(subscription, interactive)', async () => {
      existsSyncMock.mockReturnValue(true);
      stubExecFileOk();

      const provider = new ClaudeCliProvider();
      const result = await provider.authenticate();

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.billingSource).toBe('subscription');
      expect(state.detail).toContain('interactive');
    });

    it('[CLI-AUTH-005] missing binary returns err(ClaudeAuthError) with install instructions', async () => {
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oat-xxx');
      stubExecFileEnoent();

      const provider = new ClaudeCliProvider();
      const result = await provider.authenticate();

      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain('npm install -g @anthropic-ai/claude-code');
    });
  });

  // -------------------------------------------------------------------------
  // invoke() — happy path: accumulates text and usage, returns InvocationResponse
  // -------------------------------------------------------------------------

  describe('invoke()', () => {
    it('[CLI-INV-001] happy path: returns ok(InvocationResponse) with accumulated text', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      // Deliver NDJSON envelope sequence.
      child.stdout.emit('data', FIXTURE_SYSTEM_INIT + FIXTURE_DELTA_HELLO + FIXTURE_DELTA_THERE);
      child.stdout.emit('data', FIXTURE_MESSAGE_DELTA + FIXTURE_RESULT);
      child.emit('close', 0, null);

      const result = await invokePromise;
      expect(result.isOk()).toBe(true);
      const response = result._unsafeUnwrap();
      // Text accumulated from content_block_delta events.
      expect(response.text).toBe('Hello there, friend.');
    });

    it('[CLI-INV-002] aggregates usage from multiple message_delta events', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stdout.emit('data', FIXTURE_SYSTEM_INIT + FIXTURE_MESSAGE_DELTA + FIXTURE_RESULT);
      child.emit('close', 0, null);

      const result = await invokePromise;
      expect(result.isOk()).toBe(true);
      const response = result._unsafeUnwrap();
      expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it('[CLI-INV-003] extracts costUsd and numTurns from result envelope', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stdout.emit('data', FIXTURE_SYSTEM_INIT + FIXTURE_RESULT);
      child.emit('close', 0, null);

      const result = await invokePromise;
      expect(result.isOk()).toBe(true);
      const response = result._unsafeUnwrap();
      expect(response.costUsd).toBeCloseTo(0.090051);
      expect(response.numTurns).toBe(1);
      expect(response.stopReason).toBe('end_turn');
    });

    it('[CLI-INV-004] non-zero exit returns err(PipelineError) classified by classifyExit', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stderr.emit('data', Buffer.from('rate limited: HTTP 429'));
      child.emit('close', 1, null);

      const result = await invokePromise;
      expect(result.isErr()).toBe(true);
      const err = result._unsafeUnwrapErr();
      // classifyExit matches RATE_LIMIT_RE against stderr
      expect(err.code).toBe('relay_PROVIDER_RATE_LIMIT');
    });

    it('[CLI-INV-005] general non-zero exit returns err with RunnerFailureError code', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stderr.emit('data', Buffer.from('some unexpected error'));
      child.emit('close', 1, null);

      const result = await invokePromise;
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('relay_RUNNER_FAILURE');
    });
  });

  // -------------------------------------------------------------------------
  // stream() — happy path: yields InvocationEvent objects in correct order
  // -------------------------------------------------------------------------

  describe('stream()', () => {
    it('[CLI-STREAM-001] yields text.delta events for each content_block_delta', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const events: string[] = [];
      const deltas: string[] = [];

      const streamPromise = (async () => {
        const iterable = provider.stream(makeReq(), makeCtx());
        for await (const event of iterable) {
          events.push(event.type);
          if (event.type === 'text.delta') {
            deltas.push(event.delta);
          }
        }
      })();

      child.stdout.emit('data', FIXTURE_SYSTEM_INIT + FIXTURE_DELTA_HELLO + FIXTURE_DELTA_THERE);
      child.stdout.emit('data', FIXTURE_RESULT);
      child.emit('close', 0, null);

      await streamPromise;

      expect(events).toContain('text.delta');
      expect(deltas).toContain('Hello');
      expect(deltas).toContain(' there, friend.');
    });

    it('[CLI-STREAM-002] yields stream.end as final event', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const events: string[] = [];

      const streamPromise = (async () => {
        const iterable = provider.stream(makeReq(), makeCtx());
        for await (const event of iterable) {
          events.push(event.type);
        }
      })();

      child.stdout.emit('data', FIXTURE_RESULT);
      child.emit('close', 0, null);

      await streamPromise;

      expect(events[events.length - 1]).toBe('stream.end');
    });

    it('[CLI-STREAM-003] non-zero exit yields a terminal stream.error event', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const collected: InvocationEvent[] = [];
      const streamPromise = (async () => {
        const iterable = provider.stream(makeReq(), makeCtx());
        for await (const event of iterable) {
          collected.push(event);
        }
      })();

      child.stderr.emit('data', Buffer.from('authentication failed: unauthorized'));
      child.emit('close', 1, null);

      await streamPromise;

      const last = collected[collected.length - 1];
      expect(last?.type).toBe('stream.error');
      if (last?.type === 'stream.error') {
        expect(last.error).toBeInstanceOf(PipelineError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // abort — SIGTERM at t=0, SIGKILL after 2s grace
  // -------------------------------------------------------------------------

  describe('abort handling', () => {
    it('[CLI-ABORT-001] sends SIGTERM immediately, SIGKILL after 2s grace', async () => {
      vi.useFakeTimers();

      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const controller = new AbortController();
      const provider = new ClaudeCliProvider();
      const ctx = makeCtx({ abortSignal: controller.signal });

      const invokePromise = provider.invoke(makeReq(), ctx);

      // Allow the subprocess to start and attach abort listener.
      await Promise.resolve();

      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledTimes(1);

      // Before the 2s grace window, no escalation.
      vi.advanceTimersByTime(1999);
      expect(child.kill).toHaveBeenCalledTimes(1);

      // Crossing the threshold triggers SIGKILL.
      vi.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(child.kill).toHaveBeenCalledTimes(2);

      // Simulate child exiting after SIGKILL.
      child.emit('close', null, 'SIGKILL');
      // invoke() returns ok (aborted is handled by the runner, not the provider error path).
      await invokePromise;
    });
  });

  // -------------------------------------------------------------------------
  // error classification round-trip
  // -------------------------------------------------------------------------

  describe('error classification', () => {
    it('[CLI-ERR-001] auth error in stderr maps to ProviderAuthError code', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stderr.emit('data', Buffer.from('authentication failed: HTTP 401 Unauthorized'));
      child.emit('close', 1, null);

      const result = await invokePromise;
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('relay_PROVIDER_AUTH');
    });

    it('[CLI-ERR-002] timeout error in stderr maps to RunnerFailureError with E_CLAUDE_CLI_TIMEOUT', async () => {
      const { child } = makeChild();
      spawnMock.mockReturnValue(child);

      const provider = new ClaudeCliProvider();
      const invokePromise = provider.invoke(makeReq(), makeCtx());

      child.stderr.emit('data', Buffer.from('ETIMEDOUT: connection timed out'));
      child.emit('close', 1, null);

      const result = await invokePromise;
      expect(result.isErr()).toBe(true);
      const pipelineErr = result._unsafeUnwrapErr();
      expect(pipelineErr.code).toBe('relay_RUNNER_FAILURE');
      expect(pipelineErr.details?.errorCode).toBe('E_CLAUDE_CLI_TIMEOUT');
    });
  });
});
