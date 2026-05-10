import { AuthTimeoutError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AuthState, Provider } from '../providers/types.js';
import { loadFlowSettings, loadGlobalSettings } from '../settings/load.js';
import { resolveProvider } from '../settings/resolve.js';

import { RunAbortedError } from './run-internal.js';

const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

export interface ResolveAndAuthenticateOptions {
  flagProvider?: string | undefined;
  flowDir: string;
  registry: ProviderRegistry;
  authTimeoutMs?: number | undefined;
  signal: AbortSignal;
  preAuthedState?: Map<string, AuthState> | undefined;
}

/**
 * Drive the per-run provider resolution chain — flag → flow settings → global
 * settings → registry — and authenticate the resolved provider with a
 * wall-clock cap. Surfaces typed errors verbatim so the CLI exit-code mapper
 * can branch on `NoProviderConfiguredError`, `FlowDefinitionError`, and
 * `AuthTimeoutError`. Returns `authState: undefined` when the caller supplied
 * a cached `preAuthedState` entry for the resolved provider's name (the CLI
 * banner already authenticated upstream and the orchestrator should not
 * re-spawn the probe).
 */
export async function resolveAndAuthenticate(
  opts: ResolveAndAuthenticateOptions,
): Promise<{ provider: Provider; authState: AuthState | undefined }> {
  const provider = await resolveRunProvider(opts.registry, opts.flowDir, opts.flagProvider);

  if (opts.preAuthedState?.has(provider.name)) {
    return { provider, authState: opts.preAuthedState.get(provider.name) };
  }

  const authState = await authenticateProvider(provider, {
    authTimeoutMs: opts.authTimeoutMs,
    signal: opts.signal,
  });
  return { provider, authState };
}

/**
 * Resolve the default provider for a run. Reads global + per-flow settings,
 * applies the flag override, and consults the registry. Throws the typed
 * resolution error verbatim — settings IO failures, missing-provider errors,
 * and unknown-name errors all bubble to the caller without mapping.
 */
export async function resolveRunProvider(
  registry: ProviderRegistry,
  flowDir: string,
  flagProvider: string | undefined,
): Promise<Provider> {
  const globalResult = await loadGlobalSettings();
  if (globalResult.isErr()) throw globalResult.error;
  const flowResult = await loadFlowSettings(flowDir);
  if (flowResult.isErr()) throw flowResult.error;

  const args: Parameters<typeof resolveProvider>[0] = {
    flowSettings: flowResult.value,
    globalSettings: globalResult.value,
    registry,
  };
  if (flagProvider !== undefined) {
    args.flagProvider = flagProvider;
  }

  const resolved = resolveProvider(args);
  if (resolved.isErr()) throw resolved.error;
  return resolved.value;
}

/**
 * Authenticate a single provider with a wall-clock cap. Throws the provider's
 * err-branch error, an `AuthTimeoutError`, or a `RunAbortedError` — whichever
 * resolves first. The setTimeout handle is cleared and the abort listener is
 * removed on the happy path so a fast auth does not keep the event loop alive
 * past run completion and the run's AbortController does not accumulate stale
 * listeners across retries.
 */
export async function authenticateProvider(
  provider: Provider,
  opts: { authTimeoutMs?: number | undefined; signal: AbortSignal },
): Promise<AuthState> {
  if (opts.signal.aborted) throw new RunAbortedError();
  const timeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timerId = setTimeout(() => {
      reject(
        new AuthTimeoutError(
          `provider "${provider.name}" authenticate() did not settle within ${timeoutMs}ms`,
          provider.name,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortHandler = (): void => {
      reject(new RunAbortedError());
    };
    opts.signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    const auth = await Promise.race([provider.authenticate(), timeoutPromise, abortPromise]);
    if (auth.isErr()) throw auth.error;
    return auth.value;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
    if (abortHandler !== undefined) {
      opts.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Authenticate every provider in the iterable that is not already covered by
 * `preAuthedState`. Short-circuits on signal.aborted, threads the same timeout
 * into each call, and surfaces the first failing provider's error verbatim.
 * Used by the orchestrator after `checkCapabilities` surfaces per-step
 * provider overrides on top of the default already returned by
 * `resolveAndAuthenticate`.
 */
export async function authenticateProviders(
  providers: Iterable<Provider>,
  opts: {
    authTimeoutMs?: number | undefined;
    signal: AbortSignal;
    preAuthedState?: Map<string, AuthState> | undefined;
  },
): Promise<void> {
  for (const provider of providers) {
    if (opts.signal.aborted) throw new RunAbortedError();
    if (opts.preAuthedState?.has(provider.name)) continue;
    await authenticateProvider(provider, {
      authTimeoutMs: opts.authTimeoutMs,
      signal: opts.signal,
    });
  }
}
