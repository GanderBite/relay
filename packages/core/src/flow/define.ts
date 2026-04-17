import { FlowDefinitionError } from '../errors.js';
import { z } from '../zod.js';
import { buildGraph } from './graph.js';
import type { Flow, FlowSpec, Step } from './types.js';

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_ISH_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function defineFlow<TInput>(spec: FlowSpec<TInput>): Flow<TInput> {
  if (!spec.name || !KEBAB_CASE_RE.test(spec.name)) {
    throw new FlowDefinitionError(
      `flow name must be kebab-case; got '${spec.name}'`,
    );
  }

  if (!spec.version || !SEMVER_ISH_RE.test(spec.version)) {
    throw new FlowDefinitionError(
      `flow version must be semver-ish (e.g. 1.0.0); got '${spec.version}'`,
    );
  }

  if (!(spec.input instanceof z.ZodType)) {
    throw new FlowDefinitionError(
      'flow "input" must be a Zod schema (instanceof z.ZodType)',
    );
  }

  const specSteps = spec.steps;
  const stepKeys = Object.keys(specSteps);

  if (stepKeys.length === 0) {
    throw new FlowDefinitionError(
      'flow "steps" must be a non-empty object',
    );
  }

  if (spec.start !== undefined && !(spec.start in specSteps)) {
    throw new FlowDefinitionError(
      `flow "start" references unknown step "${spec.start}"`,
    );
  }

  const steps: Record<string, Step> = {};
  for (const key of stepKeys) {
    const raw = specSteps[key];
    if (raw === undefined) {
      throw new FlowDefinitionError(`step "${key}" is undefined`);
    }
    if (raw.id !== '' && raw.id !== key) {
      throw new FlowDefinitionError(
        `step "${key}" has id "${raw.id}" set manually — do not set "id" on a step; use the record key`,
      );
    }
    steps[key] = { ...raw, id: key };
  }

  const graph = buildGraph(steps, spec.start);

  const flow: Flow<TInput> = {
    ...spec,
    steps,
    graph,
    stepOrder: [...graph.topoOrder],
    rootSteps: [...graph.rootSteps],
  };

  return Object.freeze(flow);
}
