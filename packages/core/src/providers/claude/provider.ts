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
 *     raw process.env. The allowlist returns a patch (with `undefined` values
 *     for non-allowlisted keys) that the SDK merges on top of process.env,
 *     stripping inherited secrets at the subprocess boundary.
 *   - invoke() aggregates stream() through a single private iterator; there is
 *     no duplicated SDK call.
 *   - The translator is the only place snake_case SDK fields become
 *     camelCase. Downstream code never sees raw SDK shapes.
 *   - No provider-level retries. The Runner owns step retries; the SDK's own
 *     network retries are kept as-is.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { err, ok, type Result } from 'neverthrow';

import { PipelineError, StepFailureError, type FlowDefinitionError } from '../../errors.js';
import { defaultRegistry, ProviderRegistry } from '../registry.js';
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
import { extractSdkResultSummary, mergeUsage, translateSdkMessage } from './translate.js';

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface ClaudeProviderOptions {
  /**
   * Omit or set to false to block runs when `ANTHROPIC_API_KEY` is present in
   * the environment. Set to true to explicitly bill the API account (emits a
   * single warning per run).
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
// SDK option construction — pulled out so stream() reads as a thin wrapper.
// Kept pure: no logging, no side effects. The caller logs around the call.
// ---------------------------------------------------------------------------

type SdkQueryOptions = Parameters<typeof query>[0]['options'];

function buildSdkOptions(
  req: InvocationRequest,
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
    // schema }`. The schema type on the request matches the SDK's expected
    // shape, so no cast is needed at the boundary.
    options.outputFormat = {
      type: 'json_schema',
      schema: req.jsonSchema,
    };
  }
  if (req.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = req.maxBudgetUsd;
  }
  if (providerOpts.binaryPath !== undefined) {
    options.pathToClaudeCodeExecutable = providerOpts.binaryPath;
  }

  // The SDK has no direct timeout field on Options; timeouts are enforced by
  // the Runner via AbortController, so `req.timeoutMs` is handled upstream.

  // providerOptions is the declared escape hatch for SDK-specific fields the
  // core type does not model. Merge last so caller-supplied keys override any
  // computed default — but never shadow the abortController or env, which are
  // safety-critical and owned by this method.
  if (req.providerOptions !== undefined) {
    Object.assign(options, req.providerOptions);
    options.abortController = abortController;
    options.env = env;
  }

  return options;
}

// ---------------------------------------------------------------------------
// ClaudeProvider
// ---------------------------------------------------------------------------

/**
 * Tuple yielded by the private invocation iterator: the raw SDK message
 * alongside its translated events. stream() discards the raw message; invoke()
 * keeps the last `result` envelope for response-level metadata extraction.
 */
interface InvocationStep {
  readonly raw: unknown;
  readonly events: readonly InvocationEvent[];
}

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

  /**
   * Shared iterator behind both stream() and invoke(). Opens one SDK query,
   * bridges the abort signal, and yields (raw, events) pairs per SDK message.
   * Per-stream state (tool id→name map, monotonic turn counter) is resolved
   * into the translated events before yielding so downstream consumers never
   * see 'unknown' tool names or 0-turn sentinels when a real value is derivable.
   */
  async *#iterate(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncGenerator<InvocationStep, void, void> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (ctx.abortSignal.aborted) {
      controller.abort();
    } else {
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Per-stream state, scoped to a single query() invocation:
    //   - toolNames correlates tool.result events back to the tool.call that
    //     declared their name (the SDK only carries tool_use_id on results).
    //   - turnCounter is a monotonic fallback used only when the SDK omits a
    //     turn number on a turn boundary event.
    const toolNames = new Map<string, string>();
    let turnCounter = 0;

    const options = buildSdkOptions(req, this.#options, controller);
    ctx.logger.debug({ stepId: ctx.stepId, attempt: ctx.attempt }, 'claude stream opening');

    try {
      const iterator = query({ prompt: req.prompt, options });

      for await (const msg of iterator) {
        const translated = translateSdkMessage(msg);
        const events: InvocationEvent[] = [];

        for (const event of translated) {
          if (event.type === 'tool.call') {
            if (event.toolUseId !== undefined) {
              toolNames.set(event.toolUseId, event.name);
            }
            events.push(event);
            continue;
          }

          if (event.type === 'tool.result') {
            const resolved =
              event.toolUseId !== undefined
                ? toolNames.get(event.toolUseId) ?? 'unknown'
                : 'unknown';
            events.push({ ...event, name: resolved });
            continue;
          }

          if (event.type === 'turn.start') {
            if (event.turn === 0) {
              turnCounter += 1;
              events.push({ ...event, turn: turnCounter });
            } else {
              turnCounter = event.turn;
              events.push(event);
            }
            continue;
          }

          if (event.type === 'turn.end') {
            if (event.turn === 0) {
              const turn = turnCounter === 0 ? 1 : turnCounter;
              events.push({ ...event, turn });
            } else {
              events.push(event);
            }
            continue;
          }

          events.push(event);
        }

        yield { raw: msg, events };
      }
    } finally {
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  async *stream(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncIterable<InvocationEvent> {
    for await (const step of this.#iterate(req, ctx)) {
      for (const event of step.events) {
        yield event;
      }
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
    let fallbackTurnCount = 0;
    let lastRawMessage: unknown = undefined;
    let lastResultMessage: unknown = undefined;

    try {
      for await (const step of this.#iterate(req, ctx)) {
        lastRawMessage = step.raw;
        if (isResultMessage(step.raw)) {
          lastResultMessage = step.raw;
        }

        for (const event of step.events) {
          switch (event.type) {
            case 'text.delta':
              accumulatedText += event.delta;
              break;
            case 'usage':
              usage = mergeUsage(usage, event.usage);
              break;
            case 'turn.end':
              fallbackTurnCount += 1;
              break;
            default:
              break;
          }
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

    // SDK is the source of truth for response-level metadata. The request's
    // model is only used as a fallback if the SDK omits it on the result.
    const summary = extractSdkResultSummary(lastResultMessage);

    // costUsd is intentionally omitted — subscription-billed runs have no
    // truthful per-call estimate.
    const response: InvocationResponse = {
      text: accumulatedText,
      usage,
      durationMs: Date.now() - startedAt,
      numTurns: summary?.numTurns ?? fallbackTurnCount,
      model: summary?.model ?? req.model ?? '',
      stopReason: summary?.stopReason ?? null,
      raw: lastRawMessage,
    };

    if (summary?.sessionId !== undefined) {
      response.sessionId = summary.sessionId;
    }

    return ok(response);
  }
}

function describeInvokeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === 'string' ? cause : 'claude provider invocation failed';
}

function isResultMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  if (!('type' in msg)) return false;
  const record: Record<string, unknown> = msg;
  return record['type'] === 'result';
}

// ---------------------------------------------------------------------------
// Default registration
// ---------------------------------------------------------------------------

/**
 * Registers the built-in ClaudeProvider. Call once during application
 * bootstrap. Idempotency is the caller's responsibility via registry.has('claude').
 */
export function registerDefaultProviders(
  registry: ProviderRegistry = defaultRegistry,
): Result<void, FlowDefinitionError> {
  return registry.register(new ClaudeProvider());
}
