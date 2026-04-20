import { toFlowDefError } from '../../errors.js';
import { branchStepSpecSchema } from '../schemas.js';
import type { BranchStepSpec } from '../types.js';

/**
 * The shape returned by the branch builder before the flow compiler assigns an
 * id. `defineFlow` adds the `id` field from the record key.
 */
export type BranchStepBuilderOutput = Omit<BranchStepSpec, 'id'>;

/**
 * Input shape for the branch builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type BranchStepBuilderInput = Omit<BranchStepSpec, 'id' | 'kind'>;

/**
 * Build a branch step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function branchStep(spec: BranchStepBuilderInput): BranchStepBuilderOutput {
  const result = branchStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'branch' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid branch step');

  return {
    ...spec,
    kind: 'branch',
  };
}
