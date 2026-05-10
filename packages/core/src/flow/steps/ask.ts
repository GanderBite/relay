import { toFlowDefError } from '../../errors.js';
import { askStepSpecSchema } from '../schemas.js';
import type { AskStepSpec } from '../types.js';

/**
 * The shape returned by the ask builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type AskStepBuilderOutput = Omit<AskStepSpec, 'id'>;

/**
 * Input shape for the ask builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type AskStepBuilderInput = Omit<AskStepSpec, 'id' | 'kind'>;

/**
 * Build an ask step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function askStep(spec: AskStepBuilderInput): AskStepBuilderOutput {
  const result = askStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'ask' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid ask step');

  return {
    ...spec,
    kind: 'ask',
  };
}
