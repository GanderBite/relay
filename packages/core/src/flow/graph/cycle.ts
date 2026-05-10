import { err, ok, type Result } from 'neverthrow';
import { FlowDefinitionError } from '../../errors.js';
import { lookupOrThrow } from '../../util/map-utils.js';

/**
 * Kahn's topological sort. Returns the linearised step order on success or a
 * FlowDefinitionError naming the cycle path on failure. The error carries the
 * cycle as a structured field so callers can format it for diagnostic output.
 */
export function kahnTopoSort(
  keys: readonly string[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): Result<readonly string[], FlowDefinitionError> {
  const inDegree = new Map<string, number>();
  for (const key of keys) {
    // Invariant: `key` was initialised in `predecessors` by the caller.
    inDegree.set(
      key,
      lookupOrThrow(predecessors, key, '`key` was initialised in `predecessors` by the caller')
        .size,
    );
  }

  const ready = keys.filter((k) => inDegree.get(k) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);

    // Invariant: `next` originated from `ready`, which is seeded from `keys`.
    const nextSuccessors = Array.from(
      lookupOrThrow(
        successors,
        next,
        '`next` originated from `ready`, which is seeded from `keys`',
      ),
    ).sort();
    for (const succ of nextSuccessors) {
      // Invariant: `succ` is a key from `successors`, so it has an inDegree entry.
      const deg =
        lookupOrThrow(
          inDegree,
          succ,
          '`succ` is a key from `successors`, so it has an inDegree entry',
        ) - 1;
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
      { cyclePath: [...path] },
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

/**
 * Walk the residual subgraph of nodes that Kahn's algorithm could not place to
 * surface a concrete cycle path. Always picks the lexicographically smallest
 * starting node and successor so the reported path is deterministic.
 */
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
