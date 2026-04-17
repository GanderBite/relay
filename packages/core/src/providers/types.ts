/**
 * @relay/core — Provider and invocation interface types
 *
 * §4.6.1–§4.6.4: the full set of provider abstraction types.
 * Pure TypeScript interfaces and type aliases — no runtime logic, no classes,
 * no imports from errors.ts.
 *
 * Consumers: Runner, ClaudeProvider, MockProvider, flow authors.
 */

import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// §4.6.2 ProviderCapabilities
// ---------------------------------------------------------------------------

/**
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
// §4.6.4 AuthState
// ---------------------------------------------------------------------------

/**
 * Normalized auth/billing state returned by Provider.authenticate().
 * The Runner uses this for the pre-run banner and the doctor command.
 */
export interface AuthState {
  ok: boolean;

  /**
   * Stable identifier for the billing source. Surfaced in CLI/logs.
   * Spec §4.6.4 enumerates the full union.
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
// §4.6.3 Normalized invocation shape — NormalizedUsage
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
// §4.6.3 InvocationRequest
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

  /** Already converted from Zod via zod-to-json-schema. */
  jsonSchema?: object;

  maxBudgetUsd?: number;
  timeoutMs?: number;

  /** Provider-specific opaque options — escape hatch, not used by core. */
  providerOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// §4.6.3 InvocationContext
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
// §4.6.3 InvocationResponse
// ---------------------------------------------------------------------------

/**
 * Normalized response from a completed LLM invocation.
 */
export interface InvocationResponse {
  /** Canonical agent output — free-form text or a JSON string. */
  text: string;

  usage: NormalizedUsage;

  /** API-equivalent cost estimate in USD. See §4.7 for subscription billing caveats. */
  costUsd: number;

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
// §4.6.3 InvocationEvent — discriminated union
// ---------------------------------------------------------------------------

/**
 * Per-token streaming event emitted by Provider.stream().
 * Discriminated on the `type` field using the wire names from the spec.
 */
export type InvocationEvent =
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'tool.call'; name: string; input?: unknown }
  | { type: 'tool.result'; name: string; ok: boolean }
  | { type: 'usage'; usage: Partial<NormalizedUsage> }
  | { type: 'turn.end'; turn: number };

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
// §4.6.1 Provider
// ---------------------------------------------------------------------------

/**
 * The core provider abstraction.
 * Implement this interface to add any LLM backend to Relay.
 *
 * "Provider" is distinct from "Runner": the Runner (§4.9) orchestrates the
 * flow; the Provider executes a single LLM invocation.
 */
export interface Provider {
  /** Stable identifier used in flow definitions and the ProviderRegistry. */
  readonly name: string;

  /** Self-described capabilities. The Runner uses these for static checks. */
  readonly capabilities: ProviderCapabilities;

  /**
   * Pre-flight: verify the provider can be used right now.
   * Called once per Runner.run(). Throws ProviderAuthError on misconfiguration.
   */
  authenticate(): Promise<AuthState>;

  /** Execute a single LLM invocation. Required. */
  invoke(req: InvocationRequest, ctx: InvocationContext): Promise<InvocationResponse>;

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
