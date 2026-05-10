import { err, ok, type Result } from 'neverthrow';
import { GITHUB_ISSUES_URL } from '../../constants.js';
import { FlowDefinitionError } from '../../errors.js';
import type { Step } from '../types.js';

/**
 * Resolve the entry step from the explicit `start` or the discovered roots.
 * Errors when the explicit start is unknown, when the graph has no roots, or
 * when multiple roots exist and the caller did not pick one.
 */
export function findRoots(
  stepMap: Map<string, Step>,
  rootSteps: readonly string[],
  start: string | undefined,
): Result<string, FlowDefinitionError> {
  if (start !== undefined) {
    if (!stepMap.has(start)) {
      return err(
        new FlowDefinitionError(
          `start step "${start}" is not defined in this flow. Set start to an existing step id or add a step with id "${start}" in defineFlow(...).`,
        ),
      );
    }
    return ok(start);
  }

  if (rootSteps.length === 1) {
    const entry = rootSteps[0];
    if (entry === undefined) {
      // Defensive fallback when an invariant violation leaks through the guard.
      return err(
        new FlowDefinitionError(
          `unexpected graph state: rootSteps[0] is undefined despite length === 1. This is likely a bug in Relay — please report it at ${GITHUB_ISSUES_URL}.`,
        ),
      );
    }
    return ok(entry);
  }

  if (rootSteps.length === 0) {
    return err(
      new FlowDefinitionError(
        'flow has no entry step — every step has a predecessor. Remove a dependsOn reference on one step so it becomes a root, or set start: "<stepId>" in defineFlow(...) to pick an entry.',
      ),
    );
  }

  return err(
    new FlowDefinitionError(
      `flow has multiple root steps (${rootSteps.join(', ')}). Set start: "${rootSteps[0] ?? '<stepId>'}" (or another valid step id) in defineFlow(...) to pick an entry point.`,
      { rootSteps: [...rootSteps] },
    ),
  );
}
