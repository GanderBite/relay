/**
 * ClaudeProvider — the concrete Provider shipped in v1.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` function. Authentication
 * goes through `inspectClaudeAuth`, never through the SDK directly, so the
 * subscription-billing safety guard always runs before any tokens are spent.
 *
 * Design invariants:
 *   - authenticate() delegates to inspectClaudeAuth; never inlines auth checks.
 *   - stream() passes an explicit env built by buildEnvAllowlist — never the
 *     raw process.env. This contains ANTHROPIC_API_KEY leakage at the
 *     subprocess boundary.
 *   - invoke() aggregates stream() through a single code path; there is no
 *     duplicated SDK call.
 *   - The translator is the only place snake_case SDK fields become
 *     camelCase. Downstream code never sees raw SDK shapes.
 *   - No provider-level retries. The Runner owns step retries; the SDK's own
 *     network retries are kept as-is.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { err, ok, type Result } from 'neverthrow';

import { PipelineError, StepFailureError } from '../../errors.js';
import { defaultRegistry } from '../registry.js';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
  ProviderCapabilities,
} from '../types.js';
import { inspectClaudeAuth } from './auth.js';
import { buildEnvAllowlist } from './env.js';
import { mergeUsage, translateSdkMessage } from './translate.js';

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /**
   * When true, explicitly accept API-account billing if `ANTHROPIC_API_KEY`
   * is set. Omit or set to false to enforce subscription billing.
   */
  allowApiKey?: boolean;

  /**
   * Per-run env overrides merged on top of the filtered host env before
   * handoff to the SDK. Keys here always win over anything in process.env.
   */
  extraEnv?: Record<string, string>;

  /** Optional path to a specific `claude` executable. Forwarded to the SDK. */
  binaryPath?: string;
}

// ---------------------------------------------------------------------------
// Capabilities — published to the Runner so static capability checks can
// run at flow-load time, before any tokens are spent.
// ---------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Bash',
    'WebFetch',
    'WebSearch',
    'Task',
    'TodoWrite',
  ],
  multimodal: true,
  budgetCap: true,
  models: [
    'haiku',
    'sonnet',
    'opus',
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ],
  maxContextTokens: 200_000,
};

// ---------------------------------------------------------------------------
// Cost estimation — simple per-token math.
// Input and output tokens dominate; cache tokens are priced separately.
// Prices chosen as conservative upper bounds across currently-advertised
// models. Surfaced as `costUsd` on InvocationResponse, intended as an
// API-equivalent estimate (subscription users are not actually charged).
// ---------------------------------------------------------------------------

const PRICE_INPUT_PER_M_TOKENS = 3.0;
const PRICE_OUTPUT_PER_M_TOKENS = 15.0;
const PRICE_CACHE_READ_PER_M_TOKENS = 0.3;
const PRICE_CACHE_CREATE_PER_M_TOKENS = 3.75;

// TODO: read usage.total_cost_usd from the SDK when it surfaces one; until
// then, per-token math is an upper bound.
function estimateCostUsd(usage: NormalizedUsage): number {
  const perMillion = (tokens: number, price: number): number =>
    (tokens / 1_000_000) * price;
  return (
    perMillion(usage.inputTokens, PRICE_INPUT_PER_M_TOKENS) +
    perMillion(usage.outputTokens, PRICE_OUTPUT_PER_M_TOKENS) +
    perMillion(usage.cacheReadTokens, PRICE_CACHE_READ_PER_M_TOKENS) +
    perMillion(usage.cacheCreationTokens, PRICE_CACHE_CREATE_PER_M_TOKENS)
  );
}

// ---------------------------------------------------------------------------
// SDK option construction — pulled out so stream() reads as a thin wrapper.
// ---------------------------------------------------------------------------

type SdkQueryOptions = Parameters<typeof query>[0]['options'];

function buildSdkOptions(
  req: InvocationRequest,
  ctx: InvocationContext,
  providerOpts: ClaudeProviderOptions,
  abortController: AbortController,
): SdkQueryOptions {
  const env = buildEnvAllowlist({
    allowApiKey: providerOpts.allowApiKey,
    extra: providerOpts.extraEnv,
  });

  // Intentionally a plain object (not spread-built) so the SDK receives
  // undefined for fields we don't want to set — the SDK's option handler
  // treats missing and undefined identically.
  const options: SdkQueryOptions = {
    abortController,
    env,
  };

  if (req.model !== undefined) {
    options.model = req.model;
  }
  if (req.systemPrompt !== undefined) {
    options.systemPrompt = req.systemPrompt;
  }
  if (req.tools !== undefined) {
    // Restrict the available built-in tools to those requested by the step.
    options.tools = req.tools;
    // Auto-allow the requested tools so the subprocess does not prompt.
    options.allowedTools = req.tools;
  }
  if (req.jsonSchema !== undefined) {
    // SDK exposes structured output via `outputFormat: { type: 'json_schema',
    // schema }`. The schema is typed as Record<string, unknown>; callers
    // already pass a JSON Schema object, so we forward it directly. If the
    // caller passed something that is not a JSON Schema at runtime, the SDK
    // surfaces the validation error in its result message.
    options.outputFormat = {
      type: 'json_schema',
      schema: req.jsonSchema as Record<string, unknown>,
    };
  }
  if (req.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = req.maxBudgetUsd;
  }
  if (providerOpts.binaryPath !== undefined) {
    options.pathToClaudeCodeExecutable = providerOpts.binaryPath;
  }

  // Contextual hints that the SDK does not receive elsewhere.
  ctx.logger.debug({ stepId: ctx.stepId, attempt: ctx.attempt }, 'claude stream opening');

  return options;
}

// ---------------------------------------------------------------------------
// ClaudeProvider
// ---------------------------------------------------------------------------

export class ClaudeProvider implements Provider {
  readonly name = 'claude' as const;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;

  readonly #options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions = {}) {
    this.#options = options;
  }

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return inspectClaudeAuth({ allowApiKey: this.#options.allowApiKey });
  }

  async *stream(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<InvocationEvent> {
    // Bridge the Runner-owned AbortSignal to the SDK-owned AbortController.
    // Abort is one-way: if the Runner signals, the SDK controller fires.
    // We do not propagate in the other direction — if the SDK finishes
    // naturally, the Runner's signal is left untouched.
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (ctx.abortSignal.aborted) {
      controller.abort();
    } else {
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const options = buildSdkOptions(req, ctx, this.#options, controller);
      const iterator = query({ prompt: req.prompt, options });

      for await (const msg of iterator) {
        const event = translateSdkMessage(msg);
        if (event !== null) {
          yield event;
        }
      }
    } finally {
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  async invoke(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    const startedAt = Date.now();

    let accumulatedText = '';
    let usage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let turns = 0;
    let lastEvent: InvocationEvent | undefined;

    try {
      for await (const event of this.stream(req, ctx)) {
        lastEvent = event;
        switch (event.type) {
          case 'text.delta':
            accumulatedText += event.delta;
            break;
          case 'usage':
            usage = mergeUsage(usage, event.usage);
            break;
          case 'turn.end':
            turns += 1;
            break;
          default:
            // Other event types (turn.start, tool.call, tool.result) stream
            // to the UI elsewhere — they do not contribute to the aggregate
            // response object.
            break;
        }
      }
    } catch (cause) {
      return err(
        new StepFailureError(
          describeInvokeError(cause),
          ctx.stepId,
          ctx.attempt,
          { cause: String(cause) },
        ),
      );
    }

    const response: InvocationResponse = {
      text: accumulatedText,
      usage,
      costUsd: estimateCostUsd(usage),
      durationMs: Date.now() - startedAt,
      numTurns: turns,
      model: req.model ?? 'claude',
      stopReason: null,
      raw: lastEvent,
    };

    return ok(response);
  }
}

function describeInvokeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === 'string' ? cause : 'claude provider invocation failed';
}

// ---------------------------------------------------------------------------
// Default registration
//
// Side-effect import registers a zero-options ClaudeProvider into the
// default registry so consumers can reference `'claude'` in flow definitions
// without importing and wiring the provider themselves. Guarded against
// double-registration on re-import (test suites re-import modules freely).
// ---------------------------------------------------------------------------

if (!defaultRegistry.has('claude')) {
  defaultRegistry.register(new ClaudeProvider());
}
