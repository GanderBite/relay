import { RaceDefinitionError, toRaceDefError } from '../errors.js';
import { buildGraph } from './graph.js';
import { raceSpecInputSchema } from './schemas.js';
import type { BranchRunnerBuilderOutput } from './runners/branch.js';
import type { ParallelRunnerBuilderOutput } from './runners/parallel.js';
import type { PromptRunnerBuilderOutput } from './runners/prompt.js';
import type { ScriptRunnerBuilderOutput } from './runners/script.js';
import type { TerminalRunnerBuilderOutput } from './runners/terminal.js';
import type { Race, Runner } from './types.js';
import type { z } from '../zod.js';

/**
 * Union of all builder output shapes. Each member is its corresponding
 * `*RunnerSpec` without the `id` field, which the race compiler injects from
 * the record key.
 */
type RunnerBuilderOutput =
  | PromptRunnerBuilderOutput
  | ScriptRunnerBuilderOutput
  | BranchRunnerBuilderOutput
  | ParallelRunnerBuilderOutput
  | TerminalRunnerBuilderOutput;

/**
 * Input shape for `defineRace`. `steps` accepts builder outputs (without
 * `id`) rather than the compiled `Runner` type so callers do not have to set
 * placeholder ids manually.
 */
interface RaceInput<TInput> {
  name: string;
  version: string;
  description?: string;
  input: z.ZodType<TInput>;
  runners: Record<string, RunnerBuilderOutput>;
  start?: string;
}

function synthesizeStep(raw: RunnerBuilderOutput, id: string): Runner {
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

/**
 * Compile a race definition. Throws `RaceDefinitionError` synchronously when
 * the spec fails schema validation, contains a cycle, or references unknown
 * runner ids. This is load-time programmer-error validation — races that fail
 * to compile should abort module loading, not produce a runtime Result.
 */
export function defineRace<TInput>(spec: RaceInput<TInput>): Race<TInput> {
  const parseResult = raceSpecInputSchema.safeParse(spec);
  if (!parseResult.success) throw toRaceDefError(parseResult.error, 'invalid race definition');

  const specRunners = spec.runners;

  const runners: Record<string, Runner> = {};
  for (const key of Object.keys(specRunners)) {
    const raw = specRunners[key];
    if (raw === undefined) {
      throw new RaceDefinitionError(
        `runner "${key}" is undefined. Remove or replace it in defineRace({ runners: { "${key}": <runner>, ... } }).`,
      );
    }
    runners[key] = synthesizeStep(raw, key);
  }

  // Provider capability negotiation runs at Runner.run() time, not here —
  // the runner builders do not have a ProviderRegistry in scope, and the
  // runner can resolve the binding once per run.
  const graphResult = buildGraph(runners, spec.start);
  if (graphResult.isErr()) throw graphResult.error;
  const graph = graphResult.value;

  return Object.freeze({
    ...spec,
    runners,
    graph,
    runnerOrder: [...graph.topoOrder],
    rootRunners: [...graph.rootRunners],
  });
}
