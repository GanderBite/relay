import { toRaceDefError } from '../../errors.js';
import { terminalRunnerSpecSchema } from '../schemas.js';
import type { TerminalRunnerSpec } from '../types.js';

/**
 * The shape returned by the terminal builder before the race compiler assigns
 * an id. `defineRace` adds the `id` field from the record key.
 */
export type TerminalRunnerBuilderOutput = Omit<TerminalRunnerSpec, 'id'>;

/**
 * Input shape for the terminal builder. `id` is added by `defineRace` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type TerminalRunnerBuilderInput = Omit<TerminalRunnerSpec, 'id' | 'kind'>;

/**
 * Build a terminal runner spec. Throws `RaceDefinitionError` synchronously when
 * the config fails schema validation — runner builders are load-time
 * programmer-error validators, not runtime fallible operations, so an invalid
 * definition should surface at import time and abort module loading.
 */
export function terminalStep(spec: TerminalRunnerBuilderInput): TerminalRunnerBuilderOutput {
  const result = terminalRunnerSpecSchema.safeParse({ id: '_', ...spec, kind: 'terminal' });
  if (!result.success) throw toRaceDefError(result.error, 'invalid terminal runner');

  return {
    ...spec,
    kind: 'terminal',
  };
}
