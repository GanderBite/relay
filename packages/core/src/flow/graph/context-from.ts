import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import { lookupOrThrow } from '../../util/map-utils.js';
import type { Step } from '../types.js';
import { buildProducerMaps } from './producers.js';

export function resolveContextFrom(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
  isBody: boolean,
): Result<void, FlowDefinitionError> {
  const { producers, loopBodyHandoffs } = buildProducerMaps(keys, stepMap);

  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookupOrThrow(
      stepMap,
      key,
      'every `key` was inserted into `stepMap` by the caller',
    );

    // Only prompt steps declare `contextFrom`. Narrow before reading.
    if (step.kind !== 'prompt') continue;
    if (step.contextFrom === undefined || step.contextFrom.length === 0) continue;

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookupOrThrow(
      ancestorSets,
      key,
      'every `key` has an entry in `ancestorSets` (computed in topo order)',
    );

    for (const raw of step.contextFrom) {
      // Dotted ids name a handoff in a different scope (e.g. parent flow or
      // a sibling loop iteration). The compiler cannot resolve them — they
      // are validated when the runtime materialises the context.
      if (raw.includes('.')) continue;

      // A trailing '?' marks the contextFrom entry as optional. Strip it
      // before lookup; the optional marker tells the runtime to tolerate a
      // missing handoff at injection time, not the compiler.
      const isOptional = raw.endsWith('?');
      const required = isOptional ? raw.slice(0, -1) : raw;

      const writers = producers.get(required);
      if (writers === undefined) {
        // Inside a loop body, an optional ref may resolve against an outer
        // scope handoff that this body cannot see. Skip the producer check
        // in that case; the runtime will handle resolution and absence.
        if (isBody && isOptional) continue;

        // Check whether the handoff is produced inside a loop body. If so,
        // emit a targeted message explaining the dotted-notation address.
        const loopStepId = loopBodyHandoffs.get(required);
        if (loopStepId !== undefined) {
          return err(
            new FlowDefinitionError(
              `step "${key}" contextFrom references handoff "${required}" which is produced inside loop step "${loopStepId}". Address it as "${loopStepId}.${required}" to read the loop's latest output.`,
            ),
          );
        }

        return err(
          new FlowDefinitionError(
            `step "${key}" contextFrom references unknown handoff "${required}". Remove "${required}" from step "${key}"'s contextFrom array or add an upstream prompt step whose output declares handoff: "${required}" in defineFlow(...).`,
          ),
        );
      }

      // Optional refs inside a loop body do not require an ancestor writer:
      // a sibling body step (or an outer-scope step) may produce the value
      // depending on which iteration path runs.
      if (isBody && isOptional) continue;

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
            `step "${key}" contextFrom references handoff "${required}" that is not produced by any upstream step. Add a dependsOn link from step "${key}" to the step that writes handoff "${required}" in defineFlow(...).`,
          ),
        );
      }
    }
  }

  return ok(undefined);
}
