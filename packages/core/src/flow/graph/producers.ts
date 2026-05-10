import { lookupOrThrow } from '../../util/map-utils.js';
import type { Step } from '../types.js';

export function handoffNameOf(step: Step): string | undefined {
  if (step.kind === 'prompt') {
    return 'handoff' in step.output ? step.output.handoff : undefined;
  }
  // Ask steps publish the collected answer map as a handoff named after the
  // step id. The on-disk __ask_<stepId>__ file is the input written by the
  // CLI; the orchestrator reads it then writes the answer map under the
  // step id so downstream `contextFrom: ['<askStepId>']` resolves through
  // the standard handoff path.
  if (step.kind === 'ask') {
    return step.id;
  }
  return undefined;
}

/**
 * Shared producer maps used by every cross-step handoff validator.
 *
 * `producers` maps a handoff name to the set of step ids in this scope that
 * publish it (prompt steps via `output.handoff`, ask steps via their step id).
 *
 * `loopBodyHandoffs` maps a handoff name to the enclosing loop step id when
 * the handoff is produced exclusively inside a loop body. Outer-scope steps
 * cannot read those handoffs by their bare name and must use the dotted
 * `<loopStepId>.<handoff>` address; the reverse-lookup lets validators emit
 * a targeted error explaining the required form.
 */
export function buildProducerMaps(
  keys: readonly string[],
  stepMap: Map<string, Step>,
): { producers: Map<string, Set<string>>; loopBodyHandoffs: Map<string, string> } {
  const producers = new Map<string, Set<string>>();
  const loopBodyHandoffs = new Map<string, string>();

  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookupOrThrow(
      stepMap,
      key,
      'every `key` was inserted into `stepMap` by the caller',
    );

    const name = handoffNameOf(step);
    if (name !== undefined) {
      let set = producers.get(name);
      if (set === undefined) {
        set = new Set<string>();
        producers.set(name, set);
      }
      set.add(key);
    }

    if (step.kind === 'loop') {
      for (const bodyStep of Object.values(step.body)) {
        if (bodyStep === undefined) continue;
        const bodyHandoff = handoffNameOf(bodyStep);
        if (bodyHandoff !== undefined && !loopBodyHandoffs.has(bodyHandoff)) {
          loopBodyHandoffs.set(bodyHandoff, key);
        }
      }
    }
  }

  return { producers, loopBodyHandoffs };
}
