import { toRaceDefError } from '../../errors.js';
import { promptRunnerSpecSchema } from '../schemas.js';
import type { PromptRunnerSpec } from '../types.js';

/**
 * The shape returned by the prompt builder before the race compiler assigns an
 * id. `defineRace` adds the `id` field from the record key.
 */
export type PromptRunnerBuilderOutput = Omit<PromptRunnerSpec, 'id'>;

/**
 * Input shape for the prompt builder. `id` is added by `defineRace` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type PromptRunnerBuilderInput = Omit<PromptRunnerSpec, 'id' | 'kind'>;

/**
 * Build a prompt runner spec. Throws `RaceDefinitionError` synchronously when the
 * config fails schema validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function promptStep(spec: PromptRunnerBuilderInput): PromptRunnerBuilderOutput {
  const result = promptRunnerSpecSchema.safeParse({ id: '_', ...spec, kind: 'prompt' });
  if (!result.success) throw toRaceDefError(result.error, 'invalid prompt runner');

  return {
    ...spec,
    kind: 'prompt',
  };
}
