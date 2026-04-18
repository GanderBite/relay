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

  async invoke(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
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
    if (typeof value === 'function') {
      return ok(value(req, ctx));
    }
    return ok(value);
  }

  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    const result = await this.invoke(req, ctx);
    if (result.isErr()) {
      throw result.error;
    }
    const response = result.value;
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
