import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import { lookupOrThrow } from '../../util/map-utils.js';
import type { LoopStep, Step } from '../types.js';
import { buildProducerMaps } from './producers.js';

/**
 * Validate ask steps that source their questions dynamically from a prior
 * step's handoff (`questions: { from: 'handoffName' }`). The referenced
 * handoff must be produced by an upstream prompt step in the same scope —
 * a handoff written exclusively inside a loop body cannot be read by an ask
 * step that lives outside the loop, because the loop body's handoffs only
 * resolve to the dotted address `<loopStepId>.<handoff>` from outside.
 *
 * Static question arrays need no graph-level check; their schema validation
 * happens elsewhere and they carry no cross-step references.
 */
export function validateAskQuestionSources(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
): Result<void, FlowDefinitionError> {
  const { producers, loopBodyHandoffs } = buildProducerMaps(keys, stepMap);

  for (const key of keys) {
    const step = lookupOrThrow(
      stepMap,
      key,
      'every `key` was inserted into `stepMap` by the caller',
    );
    if (step.kind !== 'ask') continue;
    if (Array.isArray(step.questions)) continue;

    const from = step.questions.from;
    const writers = producers.get(from);

    if (writers === undefined) {
      const loopStepId = loopBodyHandoffs.get(from);
      if (loopStepId !== undefined) {
        return err(
          new FlowDefinitionError(
            `ask step "${key}" sources questions from handoff "${from}" which is produced inside loop step "${loopStepId}". A loop-scoped handoff cannot be read by an ask step outside the loop — move the ask step into the loop body, or have a step outside the loop produce handoff "${from}".`,
          ),
        );
      }

      return err(
        new FlowDefinitionError(
          `ask step "${key}" sources questions from unknown handoff "${from}". Add an upstream prompt step whose output declares handoff: "${from}", or replace the dynamic source with a static questions array in defineFlow(...).`,
        ),
      );
    }

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookupOrThrow(
      ancestorSets,
      key,
      'every `key` has an entry in `ancestorSets` (computed in topo order)',
    );
    let hasAncestorWriter = false;
    for (const writer of writers) {
      if (ancestors.has(writer)) {
        hasAncestorWriter = true;
        break;
      }
    }

    if (!hasAncestorWriter) {
      return err(
        new FlowDefinitionError(
          `ask step "${key}" sources questions from handoff "${from}" that is not produced by any upstream step. Add a dependsOn link from step "${key}" to the step that writes handoff "${from}" in defineFlow(...).`,
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Reject parallel barriers whose reachable subgraph contains more than one
 * ask step. Concurrent ask steps cannot share the CLI's interactive prompt,
 * so the runtime forbids fanning out to multiple ask steps from a single
 * parallel step. Loop bodies reachable from a branch are walked recursively
 * so an ask buried inside a loop body still counts toward the quota.
 */
export function validateParallelAskQuota(
  topoOrder: readonly string[],
  stepMap: Map<string, Step>,
  successors: Map<string, Set<string>>,
): Result<void, FlowDefinitionError> {
  for (const parallelId of topoOrder) {
    const parallel = lookupOrThrow(
      stepMap,
      parallelId,
      'every `parallelId` in topoOrder was inserted into stepMap above',
    );
    if (parallel.kind !== 'parallel') continue;

    const reachable = new Set<string>();
    const queue: string[] = [];
    for (const branch of parallel.branches) {
      if (!reachable.has(branch) && stepMap.has(branch)) {
        reachable.add(branch);
        queue.push(branch);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const succs = successors.get(current);
      if (succs === undefined) continue;
      for (const succ of succs) {
        if (reachable.has(succ)) continue;
        if (!stepMap.has(succ)) continue;
        reachable.add(succ);
        queue.push(succ);
      }
    }

    const askIds: string[] = [];
    for (const id of reachable) {
      const step = lookupOrThrow(
        stepMap,
        id,
        'every `id` in reachable was confirmed to exist in stepMap before being added',
      );
      if (step.kind === 'ask') {
        askIds.push(id);
        continue;
      }
      if (step.kind === 'loop') {
        collectLoopBodyAsks(step, askIds);
      }
    }

    if (askIds.length > 1) {
      askIds.sort();
      return err(
        new FlowDefinitionError(
          `parallel step "${parallelId}" has ${askIds.length} concurrent ask steps in its branches (${askIds.join(', ')}): concurrent asks are not supported — sequence them before or after the barrier.`,
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Recursively collect ask step ids inside a loop body, descending through any
 * nested loop bodies. Body steps are addressed by their bare id; the caller is
 * responsible for deduping across the outer reachable set if needed.
 */
function collectLoopBodyAsks(loopStep: LoopStep, into: string[]): void {
  for (const bodyStep of Object.values(loopStep.body)) {
    if (bodyStep === undefined) continue;
    if (bodyStep.kind === 'ask') {
      into.push(bodyStep.id);
      continue;
    }
    if (bodyStep.kind === 'loop') {
      collectLoopBodyAsks(bodyStep, into);
    }
  }
}
