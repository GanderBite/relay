import { ProviderCapabilityError } from '../errors.js';
import type { Race } from '../race/types.js';
import type { Provider } from '../providers/types.js';

/**
 * Walk every prompt runner in the race and validate the step's requirements
 * against the resolved provider's capabilities. The Runner resolves a single
 * provider for the run via the settings/flag/registry chain (see
 * `resolveProvider`); every prompt runner is bound to that provider.
 *
 * Returns a Map<runnerId, Provider> so the Runner can reuse the binding during
 * step dispatch without repeating the lookup.
 *
 * Throws ProviderCapabilityError before any tokens are spent when a step
 * requests a capability the provider does not advertise (structured output,
 * tool use, an unknown built-in tool, an unsupported model, or a per-call
 * budget cap).
 */
export function checkCapabilities(
  race: Race<unknown>,
  provider: Provider,
): Map<string, Provider> {
  const resolved = new Map<string, Provider>();
  const { capabilities } = provider;

  for (const [runnerId, runner] of Object.entries(race.runners)) {
    if (runner.kind !== 'prompt') continue;

    // Check: structured output
    if ('schema' in runner.output && runner.output.schema !== undefined) {
      if (!capabilities.structuredOutput) {
        throw new ProviderCapabilityError(
          `Runner "${runnerId}" requested structured output (output.schema set), but provider "${provider.name}" does not support structured output. ` +
            `Remove output.schema, or switch to a provider that advertises structuredOutput: true.`,
          provider.name,
          'structuredOutput',
          { runnerId, providerName: provider.name },
        );
      }
    }

    // Check: tools
    if (runner.tools !== undefined && runner.tools.length > 0) {
      if (!capabilities.tools) {
        throw new ProviderCapabilityError(
          `Runner "${runnerId}" requests tools [${runner.tools.join(', ')}], but provider "${provider.name}" does not support tool use. ` +
            `Remove the tools list, or switch to a provider that advertises tools: true.`,
          provider.name,
          'tools',
          { runnerId, providerName: provider.name, requestedTools: runner.tools },
        );
      }

      const supported = new Set(capabilities.builtInTools);
      const missing = runner.tools.filter((t) => !supported.has(t));
      if (missing.length > 0) {
        throw new ProviderCapabilityError(
          `Runner "${runnerId}" references tools [${missing.join(', ')}] that provider "${provider.name}" does not advertise. ` +
            `Supported tools: [${[...capabilities.builtInTools].join(', ')}]. ` +
            `Remove the unsupported tool names or switch to a provider that advertises them.`,
          provider.name,
          'tools',
          {
            runnerId,
            providerName: provider.name,
            missingTools: missing,
            supportedTools: [...capabilities.builtInTools],
          },
        );
      }
    }

    // Check: model
    if (
      runner.model !== undefined &&
      capabilities.models.length > 0 &&
      !capabilities.models.includes(runner.model)
    ) {
      throw new ProviderCapabilityError(
        `Runner "${runnerId}" specifies model "${runner.model}", which is not in provider "${provider.name}"'s model list: [${capabilities.models.join(', ')}]. ` +
          `Set model to one of the listed values, or leave it unset to use the provider's default.`,
        provider.name,
        'models',
        {
          runnerId,
          providerName: provider.name,
          requestedModel: runner.model,
          supportedModels: [...capabilities.models],
        },
      );
    }

    // Check: budget cap
    if (runner.maxBudgetUsd !== undefined && !capabilities.budgetCap) {
      throw new ProviderCapabilityError(
        `Runner "${runnerId}" sets maxBudgetUsd, but provider "${provider.name}" does not support per-call budget caps. ` +
          `Remove maxBudgetUsd, or switch to a provider that advertises budgetCap: true.`,
        provider.name,
        'budgetCap',
        { runnerId, providerName: provider.name, requestedBudget: runner.maxBudgetUsd },
      );
    }

    resolved.set(runnerId, provider);
  }

  return resolved;
}
