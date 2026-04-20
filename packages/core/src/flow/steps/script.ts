import { toFlowDefError } from '../../errors.js';
import { scriptStepSpecSchema } from '../schemas.js';
import type { ScriptStepSpec } from '../types.js';

/**
 * The shape returned by the script builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type ScriptStepBuilderOutput = Omit<ScriptStepSpec, 'id'>;

/**
 * Input shape for the script builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type ScriptStepBuilderInput = Omit<ScriptStepSpec, 'id' | 'kind'>;

/**
 * Build a script step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function scriptStep(spec: ScriptStepBuilderInput): ScriptStepBuilderOutput {
  const result = scriptStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'script' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid script step');

  return {
    ...spec,
    kind: 'script',
  };
}
