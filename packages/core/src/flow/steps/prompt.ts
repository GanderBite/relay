import { toFlowDefError } from '../../errors.js';
import { promptStepSpecSchema } from '../schemas.js';
import type { PromptStepSpec } from '../types.js';

/**
 * The shape returned by the prompt builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type PromptStepBuilderOutput = Omit<PromptStepSpec, 'id'>;

/**
 * Input shape for the prompt builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type PromptStepBuilderInput = Omit<PromptStepSpec, 'id' | 'kind'>;

/**
 * Build a prompt step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function promptStep(spec: PromptStepBuilderInput): PromptStepBuilderOutput {
  const result = promptStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'prompt' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid prompt step');

  return {
    ...spec,
    kind: 'prompt',
  };
}
