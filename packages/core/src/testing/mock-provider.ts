import { err, ok, type Result } from 'neverthrow';

import { type PipelineError, StepFailureError } from '../errors.js';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '../providers/types.js';

type ResponseValue =
  | InvocationResponse
  | ((
      req: InvocationRequest,
      ctx: InvocationContext,
    ) => InvocationResponse | Promise<InvocationResponse>);

export interface MockProviderOptions {
  responses: Record<string, ResponseValue>;
  capabilities?: Partial<ProviderCapabilities>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [],
  multimodal: true,
  budgetCap: true,
  models: ['mock-model'],
  maxContextTokens: 200_000,
};

export class MockProvider implements Provider {
  readonly name = 'mock' as const;
  readonly capabilities: ProviderCapabilities;

  private readonly responses: Record<string, ResponseValue>;

  constructor(opts: MockProviderOptions) {
    this.responses = opts.responses;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  }

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return ok({ ok: true, billingSource: 'local', detail: 'mock provider' });
  }

  private resolveResponseSync(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Result<InvocationResponse | Promise<InvocationResponse>, PipelineError> {
    const value = this.responses[ctx.runnerId];
    if (value === undefined) {
      return err(
        new StepFailureError(
          `MockProvider: no response configured for runnerId "${ctx.runnerId}"`,
          ctx.runnerId,
          ctx.attempt,
        ),
      );
    }
    return ok(typeof value === 'function' ? value(req, ctx) : value);
  }

  /**
   * Invokes the mock for a given step and returns a Result.
   *
   * Failures return `err(StepFailureError)`. The paired `stream()` method
   * signals the same failure by throwing inside the generator (iterator
   * termination).
   */
  async invoke(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    const called = this.resolveResponseSync(req, ctx);
    if (called.isErr()) return err(called.error);
    const response = await called.value;
    return ok(response);
  }

  /**
   * Streams invocation events for a given runner.
   *
   * Missing runnerId configuration causes `stream()` to throw `StepFailureError`
   * (via iterator termination) — the same error class `invoke()` would have
   * returned on its `err` branch. Consumers that call both must handle the two
   * surfaces consistently.
   */
  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    const called = this.resolveResponseSync(req, ctx);
    if (called.isErr()) {
      throw called.error;
    }
    const responseOrPromise = called.value;
    const response = responseOrPromise instanceof Promise
      ? await responseOrPromise
      : responseOrPromise;
    yield { type: 'turn.start', turn: 1 };
    yield { type: 'text.delta', delta: response.text };
    yield {
      type: 'usage',
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheCreationTokens: response.usage.cacheCreationTokens,
      },
    };
    yield { type: 'turn.end', turn: response.numTurns };
    yield {
      type: 'stream.end',
      stopReason: response.stopReason ?? 'end_turn',
      ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
      ...(response.sessionId !== undefined ? { sessionId: response.sessionId } : {}),
    };
  }
}
