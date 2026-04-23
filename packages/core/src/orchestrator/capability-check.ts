import { ProviderCapabilityError } from '../errors.js';
import type { Flow } from '../flow/types.js';
import type { Provider } from '../providers/types.js';

/**
 * Walk every prompt step in the flow and validate the step's requirements
 * against the resolved provider's capabilities. The Step resolves a single
 * provider for the run via the settings/flag/registry chain (see
 * `resolveProvider`); every prompt step is bound to that provider.
 *
 * Returns a Map<stepId, Provider> so the Orchestrator can reuse the binding during
 * step dispatch without repeating the lookup.
 *
 * Throws ProviderCapabilityError before any tokens are spent when a step
 * requests a capability the provider does not advertise (structured output,
 * tool use, an unknown built-in tool, an unsupported model, or a per-call
 * budget cap).
 */
export function checkCapabilities(flow: Flow<unknown>, provider: Provider): Map<string, Provider> {
  const resolved = new Map<string, Provider>();
  const { capabilities } = provider;

  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.kind !== 'prompt') continue;

    // Check: structured output
    if ('schema' in step.output && step.output.schema !== undefined) {
      if (!capabilities.structuredOutput) {
        throw new ProviderCapabilityError(
          `Step "${stepId}" requested structured output (output.schema set), but provider "${provider.name}" does not support structured output. ` +
            `Remove output.schema, or switch to a provider that advertises structuredOutput: true.`,
          provider.name,
          'structuredOutput',
          { stepId, providerName: provider.name },
        );
      }
    }

    // Check: tools
    if (step.tools !== undefined && step.tools.length > 0) {
      if (!capabilities.tools) {
        throw new ProviderCapabilityError(
          `Step "${stepId}" requests tools [${step.tools.join(', ')}], but provider "${provider.name}" does not support tool use. ` +
            `Remove the tools list, or switch to a provider that advertises tools: true.`,
          provider.name,
          'tools',
          { stepId, providerName: provider.name, requestedTools: step.tools },
        );
      }

      const supported = new Set(capabilities.builtInTools);
      const missing = step.tools.filter((t) => !supported.has(t));
      if (missing.length > 0) {
        throw new ProviderCapabilityError(
          `Step "${stepId}" references tools [${missing.join(', ')}] that provider "${provider.name}" does not advertise. ` +
            `Supported tools: [${[...capabilities.builtInTools].join(', ')}]. ` +
            `Remove the unsupported tool names or switch to a provider that advertises them.`,
          provider.name,
          'tools',
          {
            stepId,
            providerName: provider.name,
            missingTools: missing,
            supportedTools: [...capabilities.builtInTools],
          },
        );
      }
    }

    // Check: model
    if (
      step.model !== undefined &&
      capabilities.models.length > 0 &&
      !capabilities.models.includes(step.model)
    ) {
      throw new ProviderCapabilityError(
        `Step "${stepId}" specifies model "${step.model}", which is not in provider "${provider.name}"'s model list: [${capabilities.models.join(', ')}]. ` +
          `Set model to one of the listed values, or leave it unset to use the provider's default.`,
        provider.name,
        'models',
        {
          stepId,
          providerName: provider.name,
          requestedModel: step.model,
          supportedModels: [...capabilities.models],
        },
      );
    }

    // Check: budget cap
    if (step.maxBudgetUsd !== undefined && !capabilities.budgetCap) {
      throw new ProviderCapabilityError(
        `Step "${stepId}" sets maxBudgetUsd, but provider "${provider.name}" does not support per-call budget caps. ` +
          `Remove maxBudgetUsd, or switch to a provider that advertises budgetCap: true.`,
        provider.name,
        'budgetCap',
        { stepId, providerName: provider.name, requestedBudget: step.maxBudgetUsd },
      );
    }

    resolved.set(stepId, provider);
  }

  return resolved;
}
