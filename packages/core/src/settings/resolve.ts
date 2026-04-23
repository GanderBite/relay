import { err, ok, type Result } from 'neverthrow';
import { type FlowDefinitionError, NoProviderConfiguredError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { RelaySettings } from './schema.js';

export interface ResolveProviderArgs {
  flagProvider?: string;
  flowSettings: RelaySettings | null;
  globalSettings: RelaySettings | null;
  registry: ProviderRegistry;
}

export function resolveProvider(
  args: ResolveProviderArgs,
): Result<Provider, NoProviderConfiguredError | FlowDefinitionError> {
  const { flagProvider, flowSettings, globalSettings, registry } = args;

  const name = flagProvider ?? flowSettings?.provider ?? globalSettings?.provider;

  if (name === undefined) {
    return err(new NoProviderConfiguredError());
  }

  return registry.get(name);
}
