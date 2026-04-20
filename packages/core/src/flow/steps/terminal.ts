import { toFlowDefError } from '../../errors.js';
import { terminalStepSpecSchema } from '../schemas.js';
import type { TerminalStepSpec } from '../types.js';

/**
 * The shape returned by the terminal builder before the flow compiler assigns
 * an id. `defineFlow` adds the `id` field from the record key.
 */
export type TerminalStepBuilderOutput = Omit<TerminalStepSpec, 'id'>;

/**
 * Input shape for the terminal builder. `id` is added by `defineFlow` from the
 * record key, and `kind` is injected by the builder itself — so callers write
 * a minimal config object.
 */
export type TerminalStepBuilderInput = Omit<TerminalStepSpec, 'id' | 'kind'>;

/**
 * Build a terminal step spec. Throws `FlowDefinitionError` synchronously when
 * the config fails schema validation — step builders are load-time
 * programmer-error validators, not runtime fallible operations, so an invalid
 * definition should surface at import time and abort module loading.
 */
export function terminalStep(spec: TerminalStepBuilderInput): TerminalStepBuilderOutput {
  const result = terminalStepSpecSchema.safeParse({ id: '_', ...spec, kind: 'terminal' });
  if (!result.success) throw toFlowDefError(result.error, 'invalid terminal step');

  return {
    ...spec,
    kind: 'terminal',
  };
}
