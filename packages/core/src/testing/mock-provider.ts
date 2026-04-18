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
  | ((req: InvocationRequest, ctx: InvocationContext) => InvocationResponse);

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

  private resolveResponse(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Result<InvocationResponse, PipelineError> {
    const value = this.responses[ctx.stepId];
    if (value === undefined) {
      return err(
        new StepFailureError(
          `MockProvider: no response configured for stepId "${ctx.stepId}"`,
          ctx.stepId,
          ctx.attempt,
        ),
      );
    }
    const response = typeof value === 'function' ? value(req, ctx) : value;
    return ok(response);
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
    return this.resolveResponse(req, ctx);
  }

  /**
   * Streams invocation events for a given step.
   *
   * Missing stepId configuration causes `stream()` to throw `StepFailureError`
   * (via iterator termination) — the same error class `invoke()` would have
   * returned on its `err` branch. Consumers that call both must handle the two
   * surfaces consistently.
   */
  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    const result = this.resolveResponse(req, ctx);
    if (result.isErr()) {
      throw result.error;
    }
    const response = result.value;
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
  }
}
