import { FlowDefinitionError, ProviderCapabilityError } from '../errors.js';
import type { Flow, Step } from '../flow/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';

/**
 * Minimal subset of runner configuration required for provider resolution.
 * Matches the shape the Runner passes when it calls resolveProvider and
 * checkCapabilities.
 */
export interface RunnerProviderConfig {
  defaultProvider: string;
  providers: ProviderRegistry;
}

/**
 * Resolve which Provider instance serves a given step.
 *
 * Resolution order: step.provider → flow.defaultProvider → runner.defaultProvider.
 *
 * Accepts Step | undefined because flow.steps is Record<string, Step> and
 * indexed access under noUncheckedIndexedAccess returns Step | undefined.
 * Throws FlowDefinitionError when:
 *   - the step is undefined or not a prompt step (programming error)
 *   - the resolved provider name is not in the registry
 */
export function resolveProvider(
  step: Step | undefined,
  flow: Flow<unknown>,
  runner: RunnerProviderConfig,
): Provider {
  if (step === undefined) {
    throw new FlowDefinitionError(
      'resolveProvider received an undefined step. Verify the step id is present in the flow.',
    );
  }

  if (step.kind !== 'prompt') {
    throw new FlowDefinitionError(
      `resolveProvider was called on a "${step.kind}" step (id: "${step.id}"). Provider resolution only applies to prompt steps.`,
      { stepId: step.id, stepKind: step.kind },
    );
  }

  const providerName = step.provider ?? flow.defaultProvider ?? runner.defaultProvider;

  const result = runner.providers.get(providerName);
  if (result.isErr()) {
    const registeredNames = runner.providers.list().map((p) => p.name);
    throw new FlowDefinitionError(
      `Step "${step.id}" references provider "${providerName}", which is not registered. ` +
        `Registered providers: [${registeredNames.join(', ')}]. ` +
        `Register the provider via ProviderRegistry.register() before calling runner.run().`,
      {
        stepId: step.id,
        requestedProvider: providerName,
        registeredProviders: registeredNames,
      },
    );
  }

  return result.value;
}

/**
 * Walk every prompt step in the flow, resolve its provider via the three-layer
 * chain, and validate the step's requirements against that provider's capabilities.
 *
 * Returns a Map<stepId, Provider> so the Runner can reuse the resolved binding
 * during execution without repeating the lookup.
 *
 * Throws ProviderCapabilityError (or FlowDefinitionError for unknown providers)
 * before any tokens are spent.
 */
export function checkCapabilities(
  flow: Flow<unknown>,
  registry: ProviderRegistry,
  runnerDefault: string,
): Map<string, Provider> {
  const runner: RunnerProviderConfig = { defaultProvider: runnerDefault, providers: registry };
  const resolved = new Map<string, Provider>();

  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.kind !== 'prompt') continue;

    const provider = resolveProvider(step, flow, runner);

    const { capabilities } = provider;

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
