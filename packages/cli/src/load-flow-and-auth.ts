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
  loadFlowSettings,
  loadGlobalSettings,
  ok,
  type PipelineError,
  registerDefaultProviders,
  resolveProvider,
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
 * Resolve a provider from the three-tier settings chain and authenticate.
 * Settings failures are non-fatal — treated as null at that tier.
 */
export async function authenticateProvider({
  provider: flagProvider,
  cwd,
  flowDir,
}: {
  provider?: string;
  cwd: string;
  flowDir: string;
}): Promise<Result<{ resolvedProvider: Provider; authState: AuthState }, PipelineError>> {
  registerDefaultProviders();

  const [globalResult, flowResult] = await Promise.all([
    loadGlobalSettings(),
    loadFlowSettings(flowDir),
  ]);

  const globalSettings = globalResult.isOk() ? globalResult.value : null;
  const flowSettings = flowResult.isOk() ? flowResult.value : null;

  const resolveResult = resolveProvider({
    ...(flagProvider !== undefined ? { flagProvider } : {}),
    flowSettings: flowSettings ?? null,
    globalSettings: globalSettings ?? null,
    registry: defaultRegistry,
  });

  if (resolveResult.isErr()) return err(resolveResult.error);

  const resolvedProvider = resolveResult.value;
  const authResult = await resolvedProvider.authenticate();
  if (authResult.isErr()) return err(authResult.error);

  return ok({ resolvedProvider, authState: authResult.value });
}

/**
 * Load a flow package, resolve a provider, and authenticate.
 * Returns the first error encountered; settings failures are non-fatal.
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
    cwd,
    flowDir,
  });
  if (authResult.isErr()) return err(authResult.error);

  const { resolvedProvider, authState } = authResult.value;

  return ok({ flow, flowDir, resolvedProvider, authState });
}
