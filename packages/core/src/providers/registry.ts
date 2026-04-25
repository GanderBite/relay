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

  /**
   * Register a provider if no provider with the same name is present.
   * Double-registration is treated as a no-op rather than an error — callers
   * that set up default providers at module load time can safely call this
   * from multiple entry points without coordinating initialization order.
   *
   * Return value semantics differ from `register()` by design:
   * - `register()` returns `err(FlowDefinitionError)` on collision — callers
   *   that need to detect duplicates (e.g., user-defined registry setup) should
   *   use `register()`.
   * - `registerIfAbsent()` returns `ok('registered')` or `ok('already-present')`
   *   so callers can log or branch on the outcome without treating either case
   *   as an error. The `never` error type signals that this call cannot fail.
   */
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
