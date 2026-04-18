import { FlowDefinitionError } from '../errors.js';
import type { Provider } from './types.js';

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (this.#providers.has(provider.name)) {
      throw new FlowDefinitionError(`provider "${provider.name}" already registered`);
    }
    this.#providers.set(provider.name, provider);
  }

  get(name: string): Provider {
    const provider = this.#providers.get(name);
    if (provider === undefined) {
      throw new FlowDefinitionError(`unknown provider: ${name}`);
    }
    return provider;
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  list(): readonly Provider[] {
    return Array.from(this.#providers.values());
  }
}

export const defaultRegistry = new ProviderRegistry();
