import { toRaceDefError } from '../../errors.js';
import { branchRunnerSpecSchema } from '../schemas.js';
import type { BranchRunnerSpec } from '../types.js';

/**
 * The shape returned by the branch builder before the race compiler assigns an
 * id. `defineRace` adds the `id` field from the record key.
 */
export type BranchRunnerBuilderOutput = Omit<BranchRunnerSpec, 'id'>;

/**
 * Input shape for the branch builder. `id` is added by `defineRace` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type BranchRunnerBuilderInput = Omit<BranchRunnerSpec, 'id' | 'kind'>;

/**
 * Build a branch runner spec. Throws `RaceDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function branchStep(spec: BranchRunnerBuilderInput): BranchRunnerBuilderOutput {
  const result = branchRunnerSpecSchema.safeParse({ id: '_', ...spec, kind: 'branch' });
  if (!result.success) throw toRaceDefError(result.error, 'invalid branch runner');

  return {
    ...spec,
    kind: 'branch',
  };
}
