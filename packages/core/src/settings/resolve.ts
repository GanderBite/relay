import { err, ok, type Result } from 'neverthrow';
import { RaceDefinitionError, NoProviderConfiguredError } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { RelaySettings } from './schema.js';

export interface ResolveProviderArgs {
  flagProvider?: string;
  raceSettings: RelaySettings | null;
  globalSettings: RelaySettings | null;
  registry: ProviderRegistry;
}

export function resolveProvider(
  args: ResolveProviderArgs,
): Result<Provider, NoProviderConfiguredError | RaceDefinitionError> {
  const { flagProvider, raceSettings, globalSettings, registry } = args;

  const name = flagProvider ?? raceSettings?.provider ?? globalSettings?.provider;

  if (name === undefined) {
    return err(new NoProviderConfiguredError());
  }

  return registry.get(name);
}
