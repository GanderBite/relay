import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import { lookupOrThrow } from '../../util/map-utils.js';
import type { Step } from '../types.js';

/**
 * Walk every step's structural references — dependsOn, parallel branches/
 * onAllComplete, onFail, and script/branch onExit — and call addEdge for the
 * graph edges those references induce. Returns the first FlowDefinitionError
 * the walk encounters; otherwise returns ok(undefined) once every reference
 * has been validated.
 *
 * The caller owns successor/predecessor maps and the addEdge closure so this
 * function never touches the graph directly — it only emits edges via the
 * callback.
 */
export function buildEdges(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  addEdge: (from: string, to: string) => void,
): Result<void, FlowDefinitionError> {
  for (const key of keys) {
    // Invariant: `key` was just inserted into stepMap by the caller.
    const step = lookupOrThrow(stepMap, key, '`key` was just inserted into stepMap by the caller');

    if (step.dependsOn !== undefined) {
      for (const dep of step.dependsOn) {
        if (!stepMap.has(dep)) {
          return err(
            new FlowDefinitionError(
              `step "${key}" depends on unknown step "${dep}". Remove "${dep}" from step "${key}"'s dependsOn array or define a step with id "${dep}" in defineFlow(...).`,
            ),
          );
        }
        addEdge(dep, key);
      }
    }

    if (step.kind === 'parallel') {
      // Build a set of declared predecessors for O(1) lookup below.
      const depSet = new Set(step.dependsOn ?? []);

      for (const branch of step.branches) {
        if (branch === key) {
          return err(
            new FlowDefinitionError(
              `parallel step "${key}" lists itself in "branches". Remove "${key}" from the branches array in defineFlow(...) — a parallel step cannot fan out to itself.`,
            ),
          );
        }
        if (!stepMap.has(branch)) {
          return err(
            new FlowDefinitionError(
              `parallel step "${key}" branches to unknown step "${branch}". Remove "${branch}" from step "${key}"'s branches array or define a step with id "${branch}" in defineFlow(...).`,
            ),
          );
        }
        // Synthetic predecessor edge: branches must wait for the parallel step
        // before the DAG walker schedules them. Without this, a branch with no
        // explicit dependsOn becomes a root step and the walker would dispatch
        // it before the parallel step runs.
        //
        // Skip when the branch is already a declared predecessor (via
        // dependsOn). In the fan-in barrier pattern both lists name the same
        // steps; dependsOn already adds branch→parallel edges, so adding the
        // reverse would form a cycle.
        if (!depSet.has(branch)) {
          addEdge(key, branch);
        }
      }

      if (step.onAllComplete !== undefined && !stepMap.has(step.onAllComplete)) {
        return err(
          new FlowDefinitionError(
            `parallel step "${key}" onAllComplete references unknown step "${step.onAllComplete}". Set onAllComplete to an existing step id or define a step with id "${step.onAllComplete}" in defineFlow(...).`,
          ),
        );
      }
    }

    // `onFail` exists on every step kind except 'terminal' and 'ask'. Narrow
    // by kind before reading. Parallel's onFail is limited to 'abort' |
    // <stepId>, so only 'abort' is an early-return here; 'continue' is not
    // valid for parallel at the type level.
    if (step.kind !== 'terminal' && step.kind !== 'ask' && step.onFail !== undefined) {
      const onFail = step.onFail;
      const isLiteral = onFail === 'abort' || (step.kind !== 'parallel' && onFail === 'continue');
      if (!isLiteral && !stepMap.has(onFail)) {
        return err(
          new FlowDefinitionError(
            `step "${key}" onFail references unknown step "${onFail}". Set onFail to "abort", "continue", or an existing step id in defineFlow(...).`,
          ),
        );
      }
    }

    if (step.kind === 'script' || step.kind === 'branch') {
      const onExit = step.onExit;
      if (onExit !== undefined) {
        for (const exitKey of Object.keys(onExit)) {
          const value = onExit[exitKey];
          if (value === undefined) continue;
          if (value === 'abort' || value === 'continue') continue;
          if (!stepMap.has(value)) {
            return err(
              new FlowDefinitionError(
                `step "${key}" onExit["${exitKey}"] references unknown step "${value}". Set onExit["${exitKey}"] to "abort", "continue", or an existing step id in defineFlow(...).`,
              ),
            );
          }
          addEdge(key, value);
        }
      }
    }
  }

  return ok(undefined);
}
