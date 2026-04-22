/**
 * Provider package barrel — registry, types, and the
 * `registerDefaultProviders` helper that wires up both Claude backends.
 *
 * The default registration registers BOTH `ClaudeCliProvider` (subscription-
 * safe by default — spawns the local `claude` binary) AND
 * `ClaudeAgentSdkProvider` (API-account billed when ANTHROPIC_API_KEY is set
 * with explicit opt-in). Both are registered via `registerIfAbsent` so the
 * call is idempotent: a host process that has already registered a custom
 * provider under either name keeps its registration intact.
 */

import { ClaudeAgentSdkProvider } from './claude/provider.js';
import { ClaudeCliProvider } from './claude-cli/provider.js';
import { defaultRegistry, ProviderRegistry } from './registry.js';

export function registerDefaultProviders(
  registry: ProviderRegistry = defaultRegistry,
): void {
  registry.registerIfAbsent(new ClaudeCliProvider());
  registry.registerIfAbsent(new ClaudeAgentSdkProvider());
}

export { defaultRegistry, ProviderRegistry } from './registry.js';
export type {
  AuthState,
  CostEstimate,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
  ProviderCapabilities,
} from './types.js';
