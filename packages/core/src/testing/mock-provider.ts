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

  async authenticate(): Promise<AuthState> {
    return { ok: true, billingSource: 'local', detail: 'mock provider' };
  }

  async invoke(req: InvocationRequest, ctx: InvocationContext): Promise<InvocationResponse> {
    const value = this.responses[ctx.stepId];
    if (value === undefined) {
      throw new Error(`MockProvider: no response configured for stepId "${ctx.stepId}"`);
    }
    if (typeof value === 'function') {
      return value(req, ctx);
    }
    return value;
  }

  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    const response = await this.invoke(req, ctx);
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
