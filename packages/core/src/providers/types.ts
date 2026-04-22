/**
 * @relay/core — Provider and invocation interface types
 *
 * The full set of provider abstraction types: capabilities, auth state,
 * invocation request/response/context, streaming events, and the Provider
 * interface itself. Pure TypeScript interfaces and type aliases — no runtime
 * logic, no classes. The only imports are type-only.
 *
 * Consumers: Runner, ClaudeAgentSdkProvider, MockProvider, flow authors.
 */

import type { Result } from 'neverthrow';

import type { PipelineError } from '../errors.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// ProviderCapabilities
// ---------------------------------------------------------------------------

/**
 * Static descriptor each Provider publishes to the Runner.
 * Describes what an LLM provider can and cannot do.
 * Step builders check these at flow-load time before any tokens are spent.
 */
export interface ProviderCapabilities {
  /** True if the provider can stream tokens incrementally. */
  streaming: boolean;

  /** True if the provider can enforce JSON-schema-shaped output server-side. */
  structuredOutput: boolean;

  /** True if the provider supports tool/function calling. */
  tools: boolean;

  /** Names of built-in tools advertised to step.prompt({ tools }). Empty if not applicable. */
  builtInTools: readonly string[];

  /** True if the provider supports multimodal (image, audio, etc.) input. */
  multimodal: boolean;

  /** True if the provider can be told a per-call USD budget cap. */
  budgetCap: boolean;

  /** Catalog of model identifiers this provider accepts. Empty array means "any string allowed". */
  models: readonly string[];

  /** Maximum context window across all advertised models. Informational. */
  maxContextTokens: number;
}

// ---------------------------------------------------------------------------
// AuthState
// ---------------------------------------------------------------------------

/**
 * Normalized auth/billing state wrapped in the `ok(...)` branch of the Result
 * returned by Provider.authenticate(). The Runner uses this for the pre-run
 * banner and the doctor command.
 */
export interface AuthState {
  /**
   * True when authentication succeeded. Retained for consumer code that checks
   * the boolean directly; callers using the Result wrapper already have the
   * success signal from the Result branch and do not need to inspect this field.
   */
  ok: boolean;

  /**
   * Stable identifier for the billing source. Surfaced in CLI/logs.
   * Possible values: 'subscription' | 'api-account' | 'bedrock' | 'vertex' | 'foundry' | 'local' | 'unknown'.
   */
  billingSource:
    | 'subscription'
    | 'api-account'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'local'
    | 'unknown';

  /** Human-readable detail (e.g., "Pro subscription via CLAUDE_CODE_OAUTH_TOKEN"). */
  detail: string;

  /** Optional: the account/user identifier the provider is authenticated as. */
  account?: string;

  /** Warnings the user should see (e.g., "CLAUDE_CODE_OAUTH_TOKEN expires in 14 days"). */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// NormalizedUsage — token counts broken down by role
// ---------------------------------------------------------------------------

/**
 * Token usage broken down by role.
 * Providers MUST populate all fields; zeros are valid only when truly unknown.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// ---------------------------------------------------------------------------
// InvocationRequest
// ---------------------------------------------------------------------------

/**
 * Normalized LLM invocation request.
 * Every provider translates this to its own wire format internally.
 */
export interface InvocationRequest {
  /** Already-rendered prompt, with handoff context blocks interpolated. */
  prompt: string;

  /** Provider-specific model identifier; provider validates. */
  model?: string;

  systemPrompt?: string;

  /** Names from provider.capabilities.builtInTools. */
  tools?: string[];

  /** Already converted from Zod via zod-to-json-schema. Keys are schema property names. */
  jsonSchema?: Record<string, unknown>;

  maxBudgetUsd?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// InvocationContext
// ---------------------------------------------------------------------------

/**
 * Runtime context injected by the Runner into every provider call.
 * Carries flow/step identity, an abort signal, and a scoped logger.
 */
export interface InvocationContext {
  flowName: string;
  runId: string;
  stepId: string;

  /** 1-based retry counter. First attempt is 1. */
  attempt: number;

  abortSignal: AbortSignal;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// InvocationResponse
// ---------------------------------------------------------------------------

/**
 * Normalized response from a completed LLM invocation.
 */
export interface InvocationResponse {
  /** Canonical agent output — free-form text or a JSON string. */
  text: string;

  usage: NormalizedUsage;

  /**
   * API-equivalent cost estimate in USD.
   * Omit when the provider has no reliable estimate (subscription-billed runs).
   * For subscription-billed providers this reflects a compute-equivalent
   * estimate, not a charge; the Runner surfaces it as informational only.
   */
  costUsd?: number;

  durationMs: number;
  numTurns: number;

  /** Provider-assigned session identifier, if available. */
  sessionId?: string;

  /** Model identifier that actually served the response. */
  model: string;

  stopReason: string | null;

  /** Raw provider-specific payload, preserved for debugging. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// InvocationEvent — discriminated union for streaming
// ---------------------------------------------------------------------------

/**
 * Per-token streaming event emitted by Provider.stream().
 * Discriminated on the `type` field.
 */
export type InvocationEvent =
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; delta: string }
  /**
   * `toolUseId` pairs a `tool.call` event with its later `tool.result`.
   * Providers populate this when the SDK exposes a correlation id.
   */
  | { type: 'tool.call'; name: string; input?: unknown; toolUseId?: string }
  /**
   * `toolUseId` pairs a `tool.call` event with its later `tool.result`.
   * Providers populate this when the SDK exposes a correlation id.
   */
  | { type: 'tool.result'; name: string; ok: boolean; toolUseId?: string }
  | { type: 'usage'; usage: Partial<NormalizedUsage> }
  | { type: 'turn.end'; turn: number }
  /**
   * Terminal event emitted once by the provider when the SDK's final result
   * message arrives. Carries the normalized stopReason so downstream callers
   * aggregating a stream into an InvocationResponse can populate the required
   * stopReason field without re-reading the raw SDK payload. The provider
   * guarantees a non-empty string — it substitutes 'stream_completed' when
   * the SDK omits stop_reason.
   */
  | { type: 'stream.end'; stopReason: string; costUsd?: number; sessionId?: string }
  /**
   * Terminal error event emitted by a provider's stream() when the underlying
   * iteration fails. Carries a typed PipelineError so the caller can branch on
   * the error without catching a thrown value — stream() never throws. Consumers
   * that aggregate streams into an InvocationResponse treat this as the
   * stream's final event and surface the error via their own Result channel.
   */
  | { type: 'stream.error'; error: PipelineError };

// ---------------------------------------------------------------------------
// CostEstimate (used by Provider.estimateCost)
// ---------------------------------------------------------------------------

/**
 * Pre-run cost estimate returned by Provider.estimateCost().
 * Used in the CLI banner before any tokens are spent.
 */
export interface CostEstimate {
  minUsd: number;
  maxUsd: number;

  /**
   * Short descriptor string explaining how the estimate was derived.
   * Examples: 'token-counts', 'turns-heuristic'.
   */
  basis: string;
}

// ---------------------------------------------------------------------------
// Provider — the core provider abstraction
// ---------------------------------------------------------------------------

/**
 * Implement this interface to add any LLM backend to Relay.
 *
 * "Provider" is distinct from "Runner": the Runner orchestrates the
 * flow; the Provider executes a single LLM invocation.
 */
export interface Provider {
  /** Stable identifier used in flow definitions and the ProviderRegistry. */
  readonly name: string;

  /** Self-described capabilities. The Runner uses these for static checks. */
  readonly capabilities: ProviderCapabilities;

  /**
   * Pre-flight: verify the provider can be used right now. Called once per
   * Runner.run(). Returns `ok(AuthState)` on success or `err(PipelineError)`
   * on any misconfiguration — the Runner never sees a thrown error from this
   * method.
   */
  authenticate(): Promise<Result<AuthState, PipelineError>>;

  /**
   * Execute a single LLM invocation. Required. Returns `ok(InvocationResponse)`
   * on success or `err(PipelineError)` on failure — no throws.
   */
  invoke(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>>;

  /**
   * Optional: per-token streaming for the live progress display.
   * If omitted, the Runner falls back to coarser per-step events.
   */
  stream?(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent>;

  /** Optional: pre-run cost estimate for the CLI banner. */
  estimateCost?(req: InvocationRequest): Promise<CostEstimate>;

  /** Optional: dispose any long-lived resources (sockets, child processes). */
  close?(): Promise<void>;
}
