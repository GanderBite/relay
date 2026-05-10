/**
 * Shared load+auth helpers.
 *
 *   loadFlowOnly         — load flow package; no provider/auth (dry-run, validate)
 *   loadFlowAndAuth      — load flow + resolve provider + authenticate (run)
 *   authenticateProvider — resolve provider + authenticate only (resume, answer)
 */

import type { AuthState, FlowDefinitionError, Provider, Result } from '@ganderbite/relay-core';
import {
  defaultRegistry,
  err,
  ok,
  PipelineError,
  registerDefaultProviders,
  resolveAndAuthenticate,
} from '@ganderbite/relay-core';
import type { FlowLoadError, LoadedFlow } from './flow-loader.js';
import { loadFlow } from './flow-loader.js';

/** Load and validate a flow package. No provider resolution or authentication. */
export async function loadFlowOnly({
  cwd,
  nameOrPath,
}: {
  cwd: string;
  nameOrPath: string;
}): Promise<
  Result<{ flow: LoadedFlow['flow']; flowDir: string }, FlowLoadError | FlowDefinitionError>
> {
  const result = await loadFlow(nameOrPath, cwd);
  if (result.isErr()) return err(result.error);
  return ok({ flow: result.value.flow, flowDir: result.value.dir });
}

/**
 * Resolve a provider from the three-tier settings chain and authenticate it
 * with a 30-second wall-clock cap. Delegates to `resolveAndAuthenticate` from
 * core so settings IO failures, timeout, and abort are all handled identically
 * to the orchestrator's auth bootstrap — including propagating corrupt-settings
 * diagnostics rather than silently falling back to `NoProviderConfiguredError`.
 */
export async function authenticateProvider({
  provider: flagProvider,
  flowDir,
}: {
  provider?: string;
  flowDir: string;
}): Promise<Result<{ resolvedProvider: Provider; authState: AuthState }, PipelineError>> {
  registerDefaultProviders();

  const controller = new AbortController();
  try {
    const { provider, authState } = await resolveAndAuthenticate({
      ...(flagProvider !== undefined ? { flagProvider } : {}),
      flowDir,
      registry: defaultRegistry,
      authTimeoutMs: 30_000,
      signal: controller.signal,
    });

    if (authState === undefined) {
      // authState is only undefined when a preAuthedState cache hit occurs.
      // We never pass preAuthedState here, so this branch is unreachable at
      // runtime. Guard it to satisfy strict null checks.
      throw new Error('resolveAndAuthenticate returned undefined authState without preAuthedState');
    }

    return ok({ resolvedProvider: provider, authState });
  } catch (caught) {
    if (caught instanceof PipelineError) return err(caught);
    throw caught;
  }
}

/**
 * Load a flow package, resolve a provider, and authenticate.
 * Returns the first error encountered. Settings IO failures are propagated as
 * typed errors rather than silently swallowed.
 */
export async function loadFlowAndAuth({
  provider: flagProvider,
  cwd,
  nameOrPath,
}: {
  provider?: string;
  cwd: string;
  nameOrPath: string;
}): Promise<
  Result<
    { flow: LoadedFlow['flow']; flowDir: string; resolvedProvider: Provider; authState: AuthState },
    PipelineError
  >
> {
  const loadResult = await loadFlow(nameOrPath, cwd);
  if (loadResult.isErr()) return err(loadResult.error);

  const { flow, dir: flowDir } = loadResult.value;

  const authResult = await authenticateProvider({
    ...(flagProvider !== undefined ? { provider: flagProvider } : {}),
    flowDir,
  });
  if (authResult.isErr()) return err(authResult.error);

  const { resolvedProvider, authState } = authResult.value;

  return ok({ flow, flowDir, resolvedProvider, authState });
}
