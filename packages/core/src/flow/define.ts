import { err, type Result } from 'neverthrow';
import { FlowDefinitionError, toFlowDefError } from '../errors.js';
import { buildGraph } from './graph.js';
import { flowSpecInputSchema } from './schemas.js';
import type { BranchStepBuilderOutput } from './steps/branch.js';
import type { ParallelStepBuilderOutput } from './steps/parallel.js';
import type { PromptStepBuilderOutput } from './steps/prompt.js';
import type { ScriptStepBuilderOutput } from './steps/script.js';
import type { TerminalStepBuilderOutput } from './steps/terminal.js';
import type { Flow, Step } from './types.js';
import type { z } from '../zod.js';

/**
 * Union of all builder output shapes. Each member is its corresponding
 * `*StepSpec` without the `id` field, which the flow compiler injects from
 * the record key.
 */
type StepBuilderOutput =
  | PromptStepBuilderOutput
  | ScriptStepBuilderOutput
  | BranchStepBuilderOutput
  | ParallelStepBuilderOutput
  | TerminalStepBuilderOutput;

/**
 * Input shape for `defineFlow`. `steps` accepts builder outputs (without
 * `id`) rather than the compiled `Step` type so callers do not have to set
 * placeholder ids manually.
 */
interface FlowInput<TInput> {
  name: string;
  version: string;
  description?: string;
  defaultProvider?: string;
  input: z.ZodType<TInput>;
  steps: Record<string, StepBuilderOutput>;
  start?: string;
}

function synthesizeStep(raw: StepBuilderOutput, id: string): Step {
  switch (raw.kind) {
    case 'prompt':
      return { ...raw, id };
    case 'script':
      return { ...raw, id };
    case 'branch':
      return { ...raw, id };
    case 'parallel':
      return { ...raw, id };
    case 'terminal':
      return { ...raw, id };
  }
}

export function defineFlow<TInput>(
  spec: FlowInput<TInput>,
): Result<Flow<TInput>, FlowDefinitionError> {
  const parseResult = flowSpecInputSchema.safeParse(spec);
  if (!parseResult.success)
    return err(toFlowDefError(parseResult.error, 'invalid flow definition'));

  const specSteps = spec.steps;

  const steps: Record<string, Step> = {};
  for (const key of Object.keys(specSteps)) {
    const raw = specSteps[key];
    if (raw === undefined) {
      return err(
        new FlowDefinitionError(
          `step "${key}" is undefined. Remove or replace it in defineFlow({ steps: { "${key}": <step>, ... } }).`,
        ),
      );
    }
    steps[key] = synthesizeStep(raw, key);
  }

  // Provider capability negotiation runs at Runner.run() time, not here —
  // the step builders do not have a ProviderRegistry in scope, and the
  // runner can resolve the binding once per run.
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
