import { err, type Result } from 'neverthrow';
import { FlowDefinitionError, toFlowDefError } from '../errors.js';
import { buildGraph } from './graph.js';
import { flowSpecInputSchema } from './schemas.js';
import type { Flow, FlowSpec, Step } from './types.js';

export function defineFlow<TInput>(
  spec: FlowSpec<TInput>,
): Result<Flow<TInput>, FlowDefinitionError> {
  const parseResult = flowSpecInputSchema.safeParse(spec);
  if (!parseResult.success)
    return err(toFlowDefError(parseResult.error, 'invalid flow definition'));

  const specSteps = spec.steps;

  if (spec.start !== undefined && !(spec.start in specSteps)) {
    return err(new FlowDefinitionError(`flow "start" references unknown step "${spec.start}"`));
  }

  const steps: Record<string, Step> = {};
  for (const key of Object.keys(specSteps)) {
    const raw = specSteps[key];
    if (raw === undefined) {
      return err(new FlowDefinitionError(`step "${key}" is undefined`));
    }
    if (raw.id !== '' && raw.id !== key) {
      return err(
        new FlowDefinitionError(
          `step "${key}" has id "${raw.id}" set manually — do not set "id" on a step; use the record key`,
        ),
      );
    }
    steps[key] = { ...raw, id: key };
  }

  return buildGraph(steps, spec.start).map((graph) =>
    Object.freeze({
      ...spec,
      steps,
      graph,
      stepOrder: [...graph.topoOrder],
      rootSteps: [...graph.rootSteps],
    }),
  );
}
