/**
 * Provider package barrel — registry, types, and the
 * `registerDefaultProviders` helper that wires up the default Claude backend.
 *
 * The default registration registers `ClaudeCliProvider` (subscription-safe
 * by default — spawns the local `claude` binary). It is registered via
 * `registerIfAbsent` so the call is idempotent: a host process that has
 * already registered a custom provider under the same name keeps its
 * registration intact.
 */

import { ClaudeCliProvider } from './claude-cli/provider.js';
import { defaultRegistry, type ProviderRegistry } from './registry.js';

export function registerDefaultProviders(registry: ProviderRegistry = defaultRegistry): void {
  registry.registerIfAbsent(new ClaudeCliProvider());
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
