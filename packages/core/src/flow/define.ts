import { FlowDefinitionError, toFlowDefError } from '../errors.js';
import { defaultStepRegistry } from '../orchestrator/step-kind-registry.js';
// Side-effect import — populates `defaultStepRegistry` with the built-in
// step-kind entries so `synthesizeStep` below can dispatch by kind without a
// switch. The import is idempotent so re-importing here and from the
// orchestrator entry point is safe.
import '../orchestrator/step-registrations.js';
import type { z } from '../zod.js';
import { buildGraph } from './graph.js';
import { flowSpecInputSchema } from './schemas.js';
import type { AskStepBuilderOutput } from './steps/ask.js';
import type { BranchStepBuilderOutput } from './steps/branch.js';
import type { LoopStepBuilderOutput } from './steps/loop.js';
import type { ParallelStepBuilderOutput } from './steps/parallel.js';
import type { PromptStepBuilderOutput } from './steps/prompt.js';
import type { ScriptStepBuilderOutput } from './steps/script.js';
import type { TerminalStepBuilderOutput } from './steps/terminal.js';
import type { Flow, Step } from './types.js';

/**
 * Union of all builder output shapes. Each member is its corresponding
 * `*StepSpec` without the `id` field, which the flow compiler injects from
 * the record key.
 */
export type StepBuilderOutput =
  | PromptStepBuilderOutput
  | ScriptStepBuilderOutput
  | BranchStepBuilderOutput
  | ParallelStepBuilderOutput
  | TerminalStepBuilderOutput
  | LoopStepBuilderOutput
  | AskStepBuilderOutput;

/**
 * Input shape for `defineFlow`. `steps` accepts builder outputs (without
 * `id`) rather than the compiled `Step` type so callers do not have to set
 * placeholder ids manually.
 */
export interface FlowInput<TInput> {
  name: string;
  version: string;
  description?: string;
  input: z.ZodType<TInput>;
  steps: Record<string, StepBuilderOutput>;
  start?: string;
}

function synthesizeStep(raw: StepBuilderOutput, id: string): Step {
  const entry = defaultStepRegistry.get(raw.kind);
  if (entry === undefined) {
    throw new FlowDefinitionError(
      `unknown step kind "${raw.kind}" for step "${id}". Register it via defaultStepRegistry.register(...) before defining the flow.`,
    );
  }
  // The registry stores entries keyed by literal kind, so the entry's
  // synthesize signature is precisely typed for `raw.kind`. The cast on
  // `raw` re-narrows the broad union to that variant — TypeScript cannot
  // follow the discriminant through the registry's heterogeneous map.
  return entry.synthesize(raw as never, id);
}

/**
 * Compile a flow definition. Throws `FlowDefinitionError` synchronously when
 * the spec fails schema validation, contains a cycle, or references unknown
 * step ids. This is load-time programmer-error validation — flows that fail
 * to compile should abort module loading, not produce a runtime Result.
 */
export function defineFlow<TInput>(spec: FlowInput<TInput>): Flow<TInput> {
  const parseResult = flowSpecInputSchema.safeParse(spec);
  if (!parseResult.success) throw toFlowDefError(parseResult.error, 'invalid flow definition');

  const specSteps = spec.steps;

  const steps: Record<string, Step> = {};
  for (const key of Object.keys(specSteps)) {
    const raw = specSteps[key];
    if (raw === undefined) {
      throw new FlowDefinitionError(
        `step "${key}" is undefined. Remove or replace it in defineFlow({ steps: { "${key}": <step>, ... } }).`,
      );
    }
    steps[key] = synthesizeStep(raw, key);
  }

  // Provider capability negotiation runs at Orchestrator.run()() time, not here —
  // the step builders do not have a ProviderRegistry in scope, and the
  // step can resolve the binding once per run.
  const graphResult = buildGraph(steps, spec.start);
  if (graphResult.isErr()) throw graphResult.error;
  const graph = graphResult.value;

  return Object.freeze({
    ...spec,
    steps,
    graph,
    rootSteps: [...graph.rootSteps],
  });
}
