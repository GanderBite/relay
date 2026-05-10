import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import { lookupOrThrow } from '../../util/map-utils.js';
import type { FlowGraph, Step } from '../types.js';
import { computeAncestorSets } from './ancestors.js';
import { validateAskQuestionSources, validateParallelAskQuota } from './ask-questions.js';
import { buildBodyGraph } from './body.js';
import { resolveContextFrom } from './context-from.js';
import { kahnTopoSort } from './cycle.js';
import { buildEdges } from './edges.js';
import { findRoots } from './roots.js';

export function buildGraph(
  steps: Record<string, Step>,
  start?: string,
): Result<FlowGraph, FlowDefinitionError> {
  return buildGraphInternal(steps, start, false);
}

function buildGraphInternal(
  steps: Record<string, Step>,
  start: string | undefined,
  isBody: boolean,
): Result<FlowGraph, FlowDefinitionError> {
  const keys = Object.keys(steps);

  if (keys.length === 0) {
    return err(
      new FlowDefinitionError(
        'flow has no steps. Add at least one step via `steps: { ... }` in defineFlow(...).',
      ),
    );
  }

  const stepMapResult = buildStepMap(keys, steps);
  if (stepMapResult.isErr()) return err(stepMapResult.error);
  const stepMap = stepMapResult.value;

  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const key of keys) {
    successors.set(key, new Set<string>());
    predecessors.set(key, new Set<string>());
  }

  const addEdge = (from: string, to: string): void => {
    // Invariant: `from` and `to` are both keys in stepMap, so both maps
    // have an entry initialised to an empty Set above.
    successors.get(from)?.add(to);
    predecessors.get(to)?.add(from);
  };

  const edgesResult = buildEdges(keys, stepMap, addEdge);
  if (edgesResult.isErr()) return err(edgesResult.error);

  const topoResult = kahnTopoSort(keys, predecessors, successors);
  if (topoResult.isErr()) return err(topoResult.error);
  const topoOrder = topoResult.value;

  const rootSteps = keys
    // Invariant: every key in `keys` was initialised in `predecessors`.
    .filter(
      (k) =>
        lookupOrThrow(predecessors, k, 'every key in `keys` was initialised in `predecessors`')
          .size === 0,
    )
    .sort();

  const entryResult = findRoots(stepMap, rootSteps, start);
  if (entryResult.isErr()) return err(entryResult.error);
  const entry = entryResult.value;

  const ancestorSets = computeAncestorSets(topoOrder, predecessors);

  const ctxResult = resolveContextFrom(keys, stepMap, ancestorSets, isBody);
  if (ctxResult.isErr()) return err(ctxResult.error);

  const askResult = validateAskQuestionSources(keys, stepMap, ancestorSets);
  if (askResult.isErr()) return err(askResult.error);

  const parallelAskResult = validateParallelAskQuota(topoOrder, stepMap, successors);
  if (parallelAskResult.isErr()) return err(parallelAskResult.error);

  // Compile a nested mini-graph for each loop step's body. Body steps live
  // in the loop step's `body` record and never appear in this outer graph's
  // step map, edges, or topo order — they are validated as their own DAG
  // and the resulting graph is attached to the loop step in place.
  if (!isBody) {
    for (const key of topoOrder) {
      // Invariant: every key in topoOrder was inserted into stepMap above.
      const step = lookupOrThrow(
        stepMap,
        key,
        'every key in topoOrder was inserted into stepMap above',
      );
      if (step.kind !== 'loop') continue;
      const bodyResult = buildBodyGraph(step, buildGraphInternal);
      if (bodyResult.isErr()) return err(bodyResult.error);
      // Attach the compiled body graph to the loop step. The bodyGraph
      // field is declared optional on the spec and populated here once
      // the outer graph has accepted the step.
      step.bodyGraph = bodyResult.value;
    }
  }

  return ok({
    successors: freezeSets(keys, successors),
    predecessors: freezeSets(keys, predecessors),
    topoOrder,
    rootSteps,
    entry,
  });
}

function freezeSets(
  keys: readonly string[],
  source: Map<string, Set<string>>,
): Map<string, ReadonlySet<string>> {
  const frozen = new Map<string, ReadonlySet<string>>();
  for (const key of keys) {
    // Invariant: every key in `keys` was initialised in `source`.
    frozen.set(key, lookupOrThrow(source, key, 'every key in `keys` was initialised in `source`'));
  }
  return frozen;
}

/**
 * Materialise the input record into a Map<string, Step>, validating that
 * every key resolves to a defined step and that any explicit `step.id`
 * matches its key. Empty `step.id` values are tolerated because the builder
 * leaves them blank for the compiler to fill in.
 */
function buildStepMap(
  keys: readonly string[],
  steps: Record<string, Step>,
): Result<Map<string, Step>, FlowDefinitionError> {
  const stepMap = new Map<string, Step>();
  for (const key of keys) {
    const step = steps[key];
    if (step === undefined) {
      return err(
        new FlowDefinitionError(
          `step "${key}" is undefined. Assign a value via step.prompt(...), step.script(...), step.branch(...), step.parallel(...), or step.terminal(...) in defineFlow(...).`,
        ),
      );
    }
    if (step.id !== key && step.id !== '') {
      return err(
        new FlowDefinitionError(
          `step key "${key}" does not match injected id "${step.id}". Use the same id for both the "steps" map key and any explicit step.id — remove the conflicting value from the step builder arguments.`,
        ),
      );
    }
    stepMap.set(key, step);
  }
  return ok(stepMap);
}
