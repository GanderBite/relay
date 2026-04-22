import { err, ok, type Result } from 'neverthrow';
import { GITHUB_ISSUES_URL } from '../constants.js';
import { RaceDefinitionError } from '../errors.js';
import { lookup } from '../util/map-utils.js';
import type { RaceGraph, Runner } from './types.js';

export type { RaceGraph } from './types.js';

export function buildGraph(
  runners: Record<string, Runner>,
  start?: string,
): Result<RaceGraph, RaceDefinitionError> {
  const keys = Object.keys(runners);

  if (keys.length === 0) {
    return err(
      new RaceDefinitionError(
        'race has no runners. Add at least one step via `runners: { ... }` in defineRace(...).',
      ),
    );
  }

  const runnerMap = new Map<string, Runner>();
  for (const key of keys) {
    const runner = runners[key];
    if (runner === undefined) {
      return err(
        new RaceDefinitionError(
          `runner "${key}" is undefined. Assign a value via runner.prompt(...), runner.script(...), runner.branch(...), runner.parallel(...), or runner.terminal(...) in defineRace(...).`,
        ),
      );
    }
    if (runner.id !== key && runner.id !== '') {
      return err(
        new RaceDefinitionError(
          `step key "${key}" does not match injected id "${runner.id}". Use the same id for both the "runners" map key and any explicit runner.id — remove the conflicting value from the runner builder arguments.`,
        ),
      );
    }
    runnerMap.set(key, runner);
  }

  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const key of keys) {
    successors.set(key, new Set<string>());
    predecessors.set(key, new Set<string>());
  }

  const addEdge = (from: string, to: string): void => {
    // Invariant: `from` and `to` are both keys in runnerMap, so both maps
    // have an entry initialised to an empty Set above.
    successors.get(from)?.add(to);
    predecessors.get(to)?.add(from);
  };

  for (const key of keys) {
    // Invariant: `key` was just inserted into runnerMap above.
    const runner = lookup(runnerMap, key)._unsafeUnwrap();

    if (runner.dependsOn !== undefined) {
      for (const dep of runner.dependsOn) {
        if (!runnerMap.has(dep)) {
          return err(
            new RaceDefinitionError(
              `runner "${key}" depends on unknown runner "${dep}". Remove "${dep}" from runner "${key}"'s dependsOn array or define a step with id "${dep}" in defineRace(...).`,
            ),
          );
        }
        addEdge(dep, key);
      }
    }

    if (runner.kind === 'parallel') {
      for (const branch of runner.branches) {
        if (branch === key) {
          return err(
            new RaceDefinitionError(
              `parallel runner "${key}" lists itself in "branches". Remove "${key}" from the branches array in defineRace(...) — a parallel runner cannot fan out to itself.`,
            ),
          );
        }
        if (!runnerMap.has(branch)) {
          return err(
            new RaceDefinitionError(
              `parallel runner "${key}" branches to unknown runner "${branch}". Remove "${branch}" from runner "${key}"'s branches array or define a step with id "${branch}" in defineRace(...).`,
            ),
          );
        }
        // Synthetic predecessor edge: branches must wait for the parallel
        // parent before the DAG walker schedules them. Without this, a branch
        // with no explicit dependsOn becomes a root step and the walker would
        // dispatch it concurrently with the parallel parent's own dispatch
        // callback, double-billing prompt branches.
        addEdge(key, branch);
      }

      if (runner.onAllComplete !== undefined && !runnerMap.has(runner.onAllComplete)) {
        return err(
          new RaceDefinitionError(
            `parallel runner "${key}" onAllComplete references unknown runner "${runner.onAllComplete}". Set onAllComplete to an existing runner id or define a step with id "${runner.onAllComplete}" in defineRace(...).`,
          ),
        );
      }
    }

    // `onFail` exists on every step kind except 'terminal'. Narrow by kind
    // before reading. Parallel's onFail is limited to 'abort' | <runnerId>,
    // so only 'abort' is an early-return here; 'continue' is not valid for
    // parallel at the type level.
    if (runner.kind !== 'terminal' && runner.onFail !== undefined) {
      const onFail = runner.onFail;
      const isLiteral =
        onFail === 'abort' || (runner.kind !== 'parallel' && onFail === 'continue');
      if (!isLiteral && !runnerMap.has(onFail)) {
        return err(
          new RaceDefinitionError(
            `runner "${key}" onFail references unknown runner "${onFail}". Set onFail to "abort", "continue", or an existing runner id in defineRace(...).`,
          ),
        );
      }
    }

    if (runner.kind === 'script' || runner.kind === 'branch') {
      const onExit = runner.onExit;
      if (onExit !== undefined) {
        for (const exitKey of Object.keys(onExit)) {
          const value = onExit[exitKey];
          if (value === undefined) continue;
          if (value === 'abort' || value === 'continue') continue;
          if (!runnerMap.has(value)) {
            return err(
              new RaceDefinitionError(
                `runner "${key}" onExit["${exitKey}"] references unknown runner "${value}". Set onExit["${exitKey}"] to "abort", "continue", or an existing runner id in defineRace(...).`,
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

  const rootRunners = keys
    // Invariant: every key in `keys` was initialised in `predecessors`.
    .filter((k) => (lookup(predecessors, k)._unsafeUnwrap()).size === 0)
    .sort();

  const entryResult = resolveEntry(runnerMap, rootRunners, start);
  if (entryResult.isErr()) return err(entryResult.error);
  const entry = entryResult.value;

  const ancestorSets = computeAncestorSets(topoOrder, predecessors);

  const ctxResult = validateContextFrom(keys, runnerMap, ancestorSets);
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
    rootRunners,
    entry,
  });
}

function kahnTopoSort(
  keys: readonly string[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): Result<readonly string[], RaceDefinitionError> {
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
    new RaceDefinitionError(
      `cycle detected in runner dependencies: ${path.join(' -> ')}. Remove one of the dependsOn references in this cycle so the race has a valid topological order.`,
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
  runnerMap: Map<string, Runner>,
  rootRunners: readonly string[],
  start: string | undefined,
): Result<string, RaceDefinitionError> {
  if (start !== undefined) {
    if (!runnerMap.has(start)) {
      return err(
        new RaceDefinitionError(
          `start runner "${start}" is not defined in this race. Set start to an existing runner id or add a step with id "${start}" in defineRace(...).`,
        ),
      );
    }
    return ok(start);
  }

  if (rootRunners.length === 1) {
    const entry = rootRunners[0];
    if (entry === undefined) {
      // Defensive fallback when an invariant violation leaks through the guard.
      return err(
        new RaceDefinitionError(
          `unexpected graph state: rootRunners[0] is undefined despite length === 1. This is likely a bug in Relay — please report it at ${GITHUB_ISSUES_URL}.`,
        ),
      );
    }
    return ok(entry);
  }

  if (rootRunners.length === 0) {
    return err(
      new RaceDefinitionError(
        'race has no entry runner — every step has a predecessor. Remove a dependsOn reference on one step so it becomes a root, or set start: "<runnerId>" in defineRace(...) to pick an entry.',
      ),
    );
  }

  return err(
    new RaceDefinitionError(
      `race has multiple root runners (${rootRunners.join(', ')}). Set start: "${rootRunners[0] ?? '<runnerId>'}" (or another valid runner id) in defineRace(...) to pick an entry point.`,
      { rootRunners: [...rootRunners] },
    ),
  );
}

function batonNameOf(runner: Runner): string | undefined {
  if (runner.kind === 'prompt') {
    return 'baton' in runner.output ? runner.output.baton : undefined;
  }
  return undefined;
}

function validateContextFrom(
  keys: readonly string[],
  runnerMap: Map<string, Runner>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
): Result<void, RaceDefinitionError> {
  const producers = new Map<string, Set<string>>();
  for (const key of keys) {
    // Invariant: every `key` was inserted into `runnerMap` by the caller.
    const runner = lookup(runnerMap, key)._unsafeUnwrap();
    const name = batonNameOf(runner);
    if (name === undefined) continue;
    let set = producers.get(name);
    if (set === undefined) {
      set = new Set<string>();
      producers.set(name, set);
    }
    set.add(key);
  }

  for (const key of keys) {
    // Invariant: every `key` was inserted into `runnerMap` by the caller.
    const runner = lookup(runnerMap, key)._unsafeUnwrap();

    // Only prompt steps declare `contextFrom`. Narrow before reading.
    if (runner.kind !== 'prompt') continue;
    if (runner.contextFrom === undefined || runner.contextFrom.length === 0) continue;

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookup(ancestorSets, key)._unsafeUnwrap();

    for (const required of runner.contextFrom) {
      const writers = producers.get(required);
      if (writers === undefined) {
        return err(
          new RaceDefinitionError(
            `runner "${key}" contextFrom references unknown baton "${required}". Remove "${required}" from runner "${key}"'s contextFrom array or add an upstream prompt runner whose output declares baton: "${required}" in defineRace(...).`,
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
          new RaceDefinitionError(
            `runner "${key}" contextFrom references baton "${required}" that is not produced by any upstream runner. Add a dependsOn link from runner "${key}" to the runner that writes baton "${required}" in defineRace(...).`,
          ),
        );
      }
    }
  }

  return ok(undefined);
}

/**
 * Compute each step's ancestor set in a single linear pass over the topological
 * order. Ancestors(runner) = union over each predecessor p of (Ancestors(p) ∪ {p}).
 * Because topoOrder guarantees predecessors are visited before their successors,
 * every predecessor's ancestor set is already memoized when we reach the runner.
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
