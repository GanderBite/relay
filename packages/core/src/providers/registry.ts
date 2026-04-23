import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../errors.js';
import type { Provider } from './types.js';

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  register(provider: Provider): Result<void, FlowDefinitionError> {
    if (this.#providers.has(provider.name)) {
      return err(new FlowDefinitionError(`provider "${provider.name}" already registered`));
    }
    this.#providers.set(provider.name, provider);
    return ok(undefined);
  }

  /** No-op when the provider name is already present — double-registration is not an error. */
  registerIfAbsent(provider: Provider): Result<'registered' | 'already-present', never> {
    if (this.#providers.has(provider.name)) {
      return ok('already-present');
    }
    this.#providers.set(provider.name, provider);
    return ok('registered');
  }

  get(name: string): Result<Provider, FlowDefinitionError> {
    const provider = this.#providers.get(name);
    if (provider === undefined) {
      return err(new FlowDefinitionError(`unknown provider: ${name}`));
    }
    return ok(provider);
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  list(): readonly Provider[] {
    return Array.from(this.#providers.values());
  }
}

export const defaultRegistry = new ProviderRegistry();
