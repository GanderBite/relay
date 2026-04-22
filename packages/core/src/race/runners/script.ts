import { toRaceDefError } from '../../errors.js';
import { scriptRunnerSpecSchema } from '../schemas.js';
import type { ScriptRunnerSpec } from '../types.js';

/**
 * The shape returned by the script builder before the race compiler assigns an
 * id. `defineRace` adds the `id` field from the record key.
 */
export type ScriptRunnerBuilderOutput = Omit<ScriptRunnerSpec, 'id'>;

/**
 * Input shape for the script builder. `id` is added by `defineRace` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type ScriptRunnerBuilderInput = Omit<ScriptRunnerSpec, 'id' | 'kind'>;

/**
 * Build a script runner spec. Throws `RaceDefinitionError` synchronously when the
 * config fails schema validation — runner builders are load-time programmer-error
 * validators, not runtime fallible operations, so an invalid definition should
 * surface at import time and abort module loading.
 */
export function scriptStep(spec: ScriptRunnerBuilderInput): ScriptRunnerBuilderOutput {
  const result = scriptRunnerSpecSchema.safeParse({ id: '_', ...spec, kind: 'script' });
  if (!result.success) throw toRaceDefError(result.error, 'invalid script runner');

  return {
    ...spec,
    kind: 'script',
  };
}
