/**
 * Compute each step's ancestor set in a single linear pass over the topological
 * order. Ancestors(step) = union over each predecessor p of (Ancestors(p) ∪ {p}).
 * Because topoOrder guarantees predecessors are visited before their successors,
 * every predecessor's ancestor set is already memoized when we reach the step.
 * This replaces the previous per-step DFS, which was O(V * (V+E)) in aggregate.
 */
export function computeAncestorSets(
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
