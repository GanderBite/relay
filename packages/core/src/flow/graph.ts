import { err, ok, type Result } from 'neverthrow';
import { GITHUB_ISSUES_URL } from '../constants.js';
import { FlowDefinitionError } from '../errors.js';
import { lookup } from '../util/map-utils.js';
import type { FlowGraph, Step } from './types.js';

export type { FlowGraph } from './types.js';

export function buildGraph(
  steps: Record<string, Step>,
  start?: string,
): Result<FlowGraph, FlowDefinitionError> {
  const keys = Object.keys(steps);

  if (keys.length === 0) {
    return err(
      new FlowDefinitionError(
        'flow has no steps. Add at least one step via `steps: { ... }` in defineFlow(...).',
      ),
    );
  }

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

  for (const key of keys) {
    // Invariant: `key` was just inserted into stepMap above.
    const step = lookup(stepMap, key)._unsafeUnwrap();

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
      }

      if (step.onAllComplete !== undefined && !stepMap.has(step.onAllComplete)) {
        return err(
          new FlowDefinitionError(
            `parallel step "${key}" onAllComplete references unknown step "${step.onAllComplete}". Set onAllComplete to an existing step id or define a step with id "${step.onAllComplete}" in defineFlow(...).`,
          ),
        );
      }
    }

    // `onFail` exists on every step kind except 'terminal'. Narrow by kind
    // before reading. Parallel's onFail is limited to 'abort' | <stepId>,
    // so only 'abort' is an early-return here; 'continue' is not valid for
    // parallel at the type level.
    if (step.kind !== 'terminal' && step.onFail !== undefined) {
      const onFail = step.onFail;
      const isLiteral =
        onFail === 'abort' || (step.kind !== 'parallel' && onFail === 'continue');
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
        }
      }
    }
  }

  const topoResult = kahnTopoSort(keys, predecessors, successors);
  if (topoResult.isErr()) return err(topoResult.error);
  const topoOrder = topoResult.value;

  const rootSteps = keys
    // Invariant: every key in `keys` was initialised in `predecessors`.
    .filter((k) => (lookup(predecessors, k)._unsafeUnwrap()).size === 0)
    .sort();

  const entryResult = resolveEntry(stepMap, rootSteps, start);
  if (entryResult.isErr()) return err(entryResult.error);
  const entry = entryResult.value;

  const ancestorSets = computeAncestorSets(topoOrder, predecessors);

  const ctxResult = validateContextFrom(keys, stepMap, ancestorSets);
  if (ctxResult.isErr()) return err(ctxResult.error);

  const frozenSuccessors = new Map<string, ReadonlySet<string>>();
  const frozenPredecessors = new Map<string, ReadonlySet<string>>();
  for (const key of keys) {
    // Invariant: every key in `keys` was initialised in both maps.
    frozenSuccessors.set(key, lookup(successors, key)._unsafeUnwrap());
    frozenPredecessors.set(key, lookup(predecessors, key)._unsafeUnwrap());
  }

  return ok({
    successors: frozenSuccessors,
    predecessors: frozenPredecessors,
    topoOrder,
    rootSteps,
    entry,
  });
}

function kahnTopoSort(
  keys: readonly string[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): Result<readonly string[], FlowDefinitionError> {
  const inDegree = new Map<string, number>();
  for (const key of keys) {
    // Invariant: `key` was initialised in `predecessors` by the caller.
    inDegree.set(key, lookup(predecessors, key)._unsafeUnwrap().size);
  }

  const ready = keys.filter((k) => inDegree.get(k) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);

    // Invariant: `next` originated from `ready`, which is seeded from `keys`.
    const nextSuccessors = Array.from(lookup(successors, next)._unsafeUnwrap()).sort();
    for (const succ of nextSuccessors) {
      // Invariant: `succ` is a key from `successors`, so it has an inDegree entry.
      const deg = lookup(inDegree, succ)._unsafeUnwrap() - 1;
      inDegree.set(succ, deg);
      if (deg === 0) {
        insertSorted(ready, succ);
      }
    }
  }

  if (order.length === keys.length) {
    return ok(order);
  }

  const remaining = new Set(keys.filter((k) => (inDegree.get(k) ?? 0) > 0));
  const path = traceCycle(remaining, successors);
  return err(
    new FlowDefinitionError(
      `cycle detected in step dependencies: ${path.join(' -> ')}. Remove one of the dependsOn references in this cycle so the flow has a valid topological order.`,
      { cycle: path },
    ),
  );
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midValue = arr[mid];
    if (midValue !== undefined && midValue < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

function traceCycle(
  remaining: ReadonlySet<string>,
  successors: Map<string, Set<string>>,
): readonly string[] {
  const sorted = Array.from(remaining).sort();
  const start = sorted[0];
  if (start === undefined) {
    return ['<unknown>'];
  }

  const seenIndex = new Map<string, number>();
  const path: string[] = [];
  let current: string | undefined = start;

  while (current !== undefined) {
    const existing = seenIndex.get(current);
    if (existing !== undefined) {
      const cycle = path.slice(existing);
      cycle.push(current);
      return cycle;
    }
    seenIndex.set(current, path.length);
    path.push(current);

    const succs = successors.get(current);
    if (succs === undefined || succs.size === 0) {
      return path;
    }
    const succsInCycle = Array.from(succs)
      .filter((s) => remaining.has(s))
      .sort();
    current = succsInCycle[0];
  }

  return path;
}

function resolveEntry(
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

function handoffNameOf(step: Step): string | undefined {
  if (step.kind === 'prompt') {
    return 'handoff' in step.output ? step.output.handoff : undefined;
  }
  return undefined;
}

function validateContextFrom(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
): Result<void, FlowDefinitionError> {
  const producers = new Map<string, Set<string>>();
  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookup(stepMap, key)._unsafeUnwrap();
    const name = handoffNameOf(step);
    if (name === undefined) continue;
    let set = producers.get(name);
    if (set === undefined) {
      set = new Set<string>();
      producers.set(name, set);
    }
    set.add(key);
  }

  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookup(stepMap, key)._unsafeUnwrap();

    // Only prompt steps declare `contextFrom`. Narrow before reading.
    if (step.kind !== 'prompt') continue;
    if (step.contextFrom === undefined || step.contextFrom.length === 0) continue;

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookup(ancestorSets, key)._unsafeUnwrap();

    for (const required of step.contextFrom) {
      const writers = producers.get(required);
      if (writers === undefined) {
        return err(
          new FlowDefinitionError(
            `step "${key}" contextFrom references unknown handoff "${required}". Remove "${required}" from step "${key}"'s contextFrom array or add an upstream prompt step whose output declares handoff: "${required}" in defineFlow(...).`,
          ),
        );
      }

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

/**
 * Compute each step's ancestor set in a single linear pass over the topological
 * order. Ancestors(step) = union over each predecessor p of (Ancestors(p) ∪ {p}).
 * Because topoOrder guarantees predecessors are visited before their successors,
 * every predecessor's ancestor set is already memoized when we reach the step.
 * This replaces the previous per-step DFS, which was O(V * (V+E)) in aggregate.
 */
function computeAncestorSets(
  topoOrder: readonly string[],
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ancestorSets = new Map<string, ReadonlySet<string>>();

  for (const key of topoOrder) {
    const preds = predecessors.get(key);
    const merged = new Set<string>();
    if (preds !== undefined) {
      for (const pred of preds) {
        merged.add(pred);
        const predAncestors = ancestorSets.get(pred);
        if (predAncestors !== undefined) {
          for (const a of predAncestors) merged.add(a);
        }
      }
    }
    ancestorSets.set(key, merged);
  }

  return ancestorSets;
}
